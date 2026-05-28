require('dotenv').config();

const fs = require('fs');
const http = require('http');
const path = require('path');

const port = process.env.PORT || 3000;
const rootDir = __dirname;
const publicDir = path.join(rootDir, 'public');
const documentsDir = path.join(rootDir, 'documents');
const storageDir = path.join(rootDir, 'storage');
const chunksPath = path.join(storageDir, 'chunks.json');
const supportedExtensions = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.tsv', '.txt', '.md', '.markdown']);
const knowledgeNotFoundMessage = '해당 내용은 지식DB에 없습니다';
const apiNotice = 'API로 먼저 봇 질문에 대응했습니다.';
const fallbackNotice = 'API 연결 실패로 웹 로직 fallback으로 전환하여 지식DB 청크 저장소 기준으로 답변했습니다.';
const queryStopwords = new Set([
    '내용', '내용은', '핵심', '요약', '정리', '설명', '설명해줘', '알려줘',
    '무엇', '무엇인가요', '뭔가요', '어떻게', '되나요', '인가요', '주세요'
]);

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end(JSON.stringify(payload));
}

function getEnvState(value) {
    if (value === undefined) return 'missing';
    if (value === '') return 'empty';
    if (/your_|_here|api_key|발급받은/i.test(value)) return 'placeholder';
    return 'set';
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 64 * 1024) {
                reject(new Error('요청 본문이 너무 큽니다.'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!body.trim()) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error('JSON 형식이 올바르지 않습니다.'));
            }
        });
        req.on('error', reject);
    });
}

async function generateKimiAnswer(prompt) {
    const apiKey = process.env.KIMI_API_KEY;
    const apiBase = (process.env.KIMI_API_BASE || 'https://api.moonshot.ai/v1').replace(/\/$/, '');
    const model = process.env.KIMI_MODEL || 'moonshot-v1-8k';
    const temperature = Number(process.env.KIMI_TEMPERATURE || 0.2);

    if (getEnvState(apiKey) !== 'set') {
        throw new Error('KIMI_API_KEY가 설정되지 않았습니다.');
    }

    const response = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            temperature
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`KIMI 응답 생성 실패: ${response.status} ${response.statusText} ${errorText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || data?.text || data?.response;
    if (!content) {
        throw new Error('KIMI 응답 본문이 비어 있습니다.');
    }

    return { content, provider: 'kimi', model };
}

function loadChunks() {
    if (!fs.existsSync(chunksPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
    } catch (error) {
        console.warn('chunks.json 로드 실패:', error.message);
        return [];
    }
}

function cleanExtractedText(text, ext) {
    let cleaned = String(text || '')
        .replace(/\u0000/g, ' ')
        .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, ' ');

    if (['.md', '.markdown'].includes(ext)) {
        cleaned = cleaned
            .replace(/<img\b[^>]*>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/!\[[^\]]*]\([^)]*\)/g, ' ');
    }

    return cleaned
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim();
}

async function loadDocument(filePath, file) {
    const ext = path.extname(file).toLowerCase();

    if (ext === '.pdf') {
        const pdf = require('pdf-parse');
        const data = await pdf(fs.readFileSync(filePath));
        return [{
            pageContent: cleanExtractedText(data.text, ext),
            metadata: { source: file, type: 'pdf', pages: data.numpages }
        }];
    }

    if (ext === '.docx') {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        return [{
            pageContent: cleanExtractedText(result.value, ext),
            metadata: { source: file, type: 'docx' }
        }];
    }

    if (['.xlsx', '.xls', '.csv', '.tsv'].includes(ext)) {
        const XLSX = require('xlsx');
        const workbook = XLSX.readFile(filePath, { cellDates: true });
        return workbook.SheetNames.map(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const text = XLSX.utils.sheet_to_csv(sheet, { FS: '\t', blankrows: false });
            return {
                pageContent: cleanExtractedText(text, ext),
                metadata: { source: file, type: ext.slice(1), sheet: sheetName }
            };
        });
    }

    if (['.txt', '.md', '.markdown'].includes(ext)) {
        return [{
            pageContent: cleanExtractedText(fs.readFileSync(filePath, 'utf8'), ext),
            metadata: { source: file, type: ext.slice(1) }
        }];
    }

    return [];
}

function splitTextIntoChunks(text, metadata, chunkSize = 1000, chunkOverlap = 200) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];

    const chunks = [];
    let start = 0;
    while (start < normalized.length) {
        let end = Math.min(start + chunkSize, normalized.length);
        if (end < normalized.length) {
            const breakPoint = Math.max(
                normalized.lastIndexOf('. ', end),
                normalized.lastIndexOf('? ', end),
                normalized.lastIndexOf('! ', end),
                normalized.lastIndexOf('다. ', end),
                normalized.lastIndexOf('요. ', end),
                normalized.lastIndexOf(' ', end)
            );
            if (breakPoint > start + Math.floor(chunkSize * 0.55)) {
                end = breakPoint + 1;
            }
        }

        const pageContent = normalized.slice(start, end).trim();
        if (pageContent.length > 0) {
            chunks.push({
                pageContent,
                metadata: {
                    ...metadata,
                    chunk: chunks.length + 1
                }
            });
        }

        if (end >= normalized.length) break;
        start = Math.max(0, end - chunkOverlap);
    }

    return chunks;
}

async function ingestDocuments() {
    if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

    const files = listDocumentFiles();
    const allChunks = [];
    const fileStats = {};
    const skippedFiles = [];

    for (const file of files) {
        const filePath = path.join(documentsDir, file);
        const docs = await loadDocument(filePath, file);
        const readableDocs = docs.filter(doc => doc.pageContent && doc.pageContent.trim().length > 0);
        const chunks = readableDocs.flatMap(doc => splitTextIntoChunks(doc.pageContent, doc.metadata));

        fileStats[file] = {
            sections: docs.length,
            readableSections: readableDocs.length,
            extractedChars: readableDocs.reduce((sum, doc) => sum + doc.pageContent.trim().length, 0),
            chunks: chunks.length
        };

        if (chunks.length === 0) {
            skippedFiles.push(file);
            continue;
        }

        allChunks.push(...chunks);
    }

    const payload = allChunks.map((doc, index) => ({
        id: index,
        pageContent: doc.pageContent,
        metadata: doc.metadata || {}
    }));
    fs.writeFileSync(chunksPath, JSON.stringify(payload, null, 2), 'utf8');

    return {
        message: `총 ${files.length}개 파일을 ${payload.length}개 청크로 지식DB에 저장했습니다.`,
        documentsCount: files.length,
        chunksCount: payload.length,
        skippedFiles,
        fileStats
    };
}

function sourceStats(chunks) {
    return chunks.reduce((acc, chunk) => {
        const source = chunk?.metadata?.source || 'unknown';
        acc[source] = (acc[source] || 0) + 1;
        return acc;
    }, {});
}

function tokenize(text) {
    return String(text || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_.-]/gu, ' ')
        .split(/\s+/)
        .map(token => token.trim())
        .filter(token => token.length >= 2)
        .filter(token => !queryStopwords.has(token));
}

function keywordSearch(question, limit = 8) {
    const chunks = loadChunks();
    const queryTokens = tokenize(question);
    if (chunks.length === 0 || queryTokens.length === 0) return [];

    const normalizedQuestion = String(question || '').normalize('NFC').toLowerCase();
    const preferredSourceHints = [];
    if (normalizedQuestion.includes('코칭') || normalizedQuestion.includes('gps')) preferredSourceHints.push('코칭', 'gps');
    if (normalizedQuestion.includes('경쟁사') || normalizedQuestion.includes('경쟁사분석')) preferredSourceHints.push('경쟁사');

    const scored = chunks.map(chunk => {
        const content = String(chunk.pageContent || '').normalize('NFC').toLowerCase();
        const source = String(chunk.metadata?.source || '').normalize('NFC').toLowerCase();
        let score = 0;
        let contentScore = 0;
        let matchedTokenCount = 0;

        for (const token of queryTokens) {
            if (content.includes(token)) {
                // 토큰 빈도수에 비례한 가중치
                const freq = (content.match(new RegExp(token, 'g')) || []).length;
                const tokenScore = 8 + Math.min(freq - 1, 4) * 2;
                score += tokenScore;
                contentScore += tokenScore;
                matchedTokenCount++;
            }
            if (source.includes(token)) score += 5;
        }

        // 질문 키워드 중 절반 이상 매칭된 청크에 보너스
        if (queryTokens.length > 0 && matchedTokenCount / queryTokens.length >= 0.5) {
            score += 15;
        }

        if (normalizedQuestion.includes('코칭') && source.includes('코칭')) score += 20;
        if (normalizedQuestion.includes('gps') && source.includes('gps')) score += 20;
        if (normalizedQuestion.includes('경쟁사') && source.includes('경쟁사')) score += 25;
        if (normalizedQuestion.includes('분석') && source.includes('분석')) score += 10;

        return { chunk, score, contentScore };
    });

    // 최소 점수 임계값: 질문 키워드 2개 이상 실제 포함 청크만 허용
    const MIN_SCORE = 16;
    const allPositive = scored.filter(item => item.score >= MIN_SCORE).sort((a, b) => b.score - a.score);
    const contentPositive = scored.filter(item => item.contentScore >= MIN_SCORE).sort((a, b) => b.score - a.score);
    const positive = contentPositive.length > 0 ? contentPositive : allPositive;

    const focused = preferredSourceHints.length > 0
        ? positive.filter(item => {
            const source = String(item.chunk.metadata?.source || '').normalize('NFC').toLowerCase();
            return preferredSourceHints.some(hint => source.includes(hint));
        })
        : [];

    return (focused.length > 0 ? focused : positive).slice(0, limit).map(item => ({
        pageContent: item.chunk.pageContent,
        metadata: { ...item.chunk.metadata, retrieval: 'keyword', score: item.score }
    }));
}

// 청크 내에서 질문 키워드가 포함된 문장만 추출
function extractRelevantSentences(text, queryTokens, maxSentences = 5, contextWindow = 0) {
    if (!text || queryTokens.length === 0) return '';

    const raw = text.replace(/\s+/g, ' ').trim();

    // PDF 청크 실제 형식: 마침표+공백 기준 분리
    const sentences = raw.split(/\.\s+/).map(s => s.trim()).filter(s => s.length > 10);
    if (sentences.length === 0) return '';

    // 각 문장의 관련도 점수 계산
    const sentenceScores = sentences.map((sent, idx) => {
        const lower = sent.normalize('NFC').toLowerCase();
        let score = 0;
        for (const token of queryTokens) {
            if (lower.includes(token)) score += 10;
        }
        return { sent, idx, score };
    });

    // 점수 > 0 인 문장 중 상위 maxSentences개 선택 + contextWindow 확장
    const relevant = new Set();
    sentenceScores
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSentences)
        .forEach(item => {
            for (let i = Math.max(0, item.idx - contextWindow); i <= Math.min(sentences.length - 1, item.idx + contextWindow); i++) {
                relevant.add(i);
            }
        });

    if (relevant.size === 0) return '';

    return [...relevant].sort((a, b) => a - b).map(i => sentences[i]).join('. ');
}


function buildExtractiveAnswer(docs, question) {
    if (docs.length === 0) return { answer: knowledgeNotFoundMessage, sources: [] };

    const queryTokens = tokenize(question || '');

    // 전역 문장 dedupe: overlap 청크에서 동일 문장 재출력 방지
    const seenSentences = new Set();
    const mergedBySource = {};

    for (const doc of docs) {
        const source = doc.metadata?.source || '문서';
        const raw = doc.pageContent.replace(/\s+/g, ' ').trim();

        // 마침표+공백 기준 문장 분리
        const sentences = raw.split(/\.\s+/).map(s => s.trim()).filter(s => s.length > 10);

        // 각 문장 점수 계산
        const scored = sentences.map((sent, idx) => {
            const lower = sent.normalize('NFC').toLowerCase();
            let score = 0;
            for (const token of queryTokens) {
                if (lower.includes(token)) score += 10;
            }
            return { sent, idx, score };
        });

        // 상위 관련 문장 추출 (contextWindow=0: 정확히 매칭 문장만)
        const selected = new Set();
        scored
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .forEach(item => selected.add(item.idx));

        if (selected.size === 0) continue;

        // 개별 문장 dedupe 후 수집
        const uniqueSents = [];
        for (const idx of [...selected].sort((a, b) => a - b)) {
            const sent = sentences[idx];
            const key = sent.replace(/\s+/g, '').slice(0, 80);
            if (!seenSentences.has(key)) {
                seenSentences.add(key);
                uniqueSents.push(sent);
            }
        }

        if (uniqueSents.length === 0) continue;
        if (!mergedBySource[source]) mergedBySource[source] = [];
        mergedBySource[source].push(uniqueSents.join('. '));
    }

    if (Object.keys(mergedBySource).length === 0) {
        return { answer: knowledgeNotFoundMessage, sources: [] };
    }

    const answerParts = Object.entries(mergedBySource).map(([source, texts]) => {
        return `**[${source}]**\n${texts.join('\n')}`;
    });

    const uniqueSources = Object.keys(mergedBySource);

    return {
        answer: `${answerParts.join('\n\n')}\n\n참고: ${uniqueSources.join(', ')}`,
        sources: uniqueSources
    };
}

function buildRagPrompt(question, docs) {
    const context = docs.map((doc, i) => `[청크 ${i + 1}] (출처: ${doc.metadata?.source || '문서'})\n${doc.pageContent}`).join('\n\n');
    return `당신은 회사의 규정, 지침, 지식을 제공하는 챗봇입니다.
사용자가 지식DB 범위에 해당하는 질문을 하면, 문맥에 기반하여 답변하고 인용 문서를 알려주세요.

[정보원 제한]
유일한 정보원은 아래 [문서청크 저장소]입니다.

[답변 원칙 - 반드시 준수]
1. 청크 저장소에 명시된 내용만 사용해 답변합니다.
2. 인용한 문서가 복수일 경우, 전부 표시합니다 (예: 참고: 문서A.pdf, 문서B.docx).
3. 청크 저장소에 있는 내용은 찾아서 해당 내용만 답변합니다.
4. "자세한 내용은 사내 관련 문서를 참고하시거나", "담당자에게 문의하시기 바랍니다" 등의 부연 문구는 절대 추가하지 않습니다.
5. 문서에 근거가 없거나 지식DB와 직접 연결할 수 없는 내용은 절대 추측하거나 일반 상식으로 보충하지 않습니다.
6. 관련 정보를 찾지 못한 경우, 정확히 다음과 같이만 답합니다: "${knowledgeNotFoundMessage}"
7. 사용자의 주장·정보가 규정과 다를 경우, 다음 형식으로 답합니다: "문의하신 내용은 규정과 다릅니다. 지식DB에 따르면 (규정 내용 요약)"
8. 규정의 표현을 왜곡하지 말고, 핵심 문장을 요약하여 설명하되 필요하면 원문도 함께 제시합니다.
9. 규정에 없는 부가적인 조언(개인적 의견, 관행, 추정)은 절대 하지 않습니다.

[문서청크 저장소]
${context}

[사용자 질문]
${question}`.trim();
}

function normalizeKimiAnswer(answer, sources) {
    const text = String(answer || '').trim();
    if (text.includes(knowledgeNotFoundMessage)) {
        return { answer: knowledgeNotFoundMessage, sources: [] };
    }

    const uniqueSources = [...new Set(sources)].filter(Boolean);
    if (uniqueSources.length === 0) {
        return { answer: text, sources: [] };
    }

    const body = text
        .split('\n')
        .filter(line => !line.trim().startsWith('참고:'))
        .join('\n')
        .trim();

    return {
        answer: `${body}\n\n참고: ${uniqueSources.join(', ')}`,
        sources: uniqueSources
    };
}

function listDocumentFiles() {
    if (!fs.existsSync(documentsDir)) return [];
    return fs.readdirSync(documentsDir).filter(file => supportedExtensions.has(path.extname(file).toLowerCase()));
}

function contentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
}

function serveStatic(req, res, pathname) {
    const requested = pathname === '/' ? '/index.html' : pathname;
    const filePath = path.normalize(path.join(publicDir, requested));
    if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'OPTIONS') return sendJson(res, 204, {});

    try {
        if (req.method === 'GET' && pathname === '/api/status') {
            const chunks = loadChunks();
            return sendJson(res, 200, {
                server: { ready: true, port: String(port), mode: 'fast-local' },
                vectorStore: { loaded: false, chunksCount: 0 },
                chunkStore: { loaded: chunks.length > 0, chunksCount: chunks.length },
                sources: sourceStats(chunks),
                documents: {
                    supportedCount: listDocumentFiles().length,
                    supportedExtensions: Array.from(supportedExtensions)
                },
                gemini: {
                    apiKeyState: process.env.GOOGLE_API_KEY ? 'set' : 'missing',
                    model: process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash',
                    apiVersion: process.env.GEMINI_API_VERSION || 'v1'
                },
                kimi: {
                    apiBase: process.env.KIMI_API_BASE || 'https://api.moonshot.ai/v1',
                    apiKeyState: getEnvState(process.env.KIMI_API_KEY),
                    model: process.env.KIMI_MODEL || 'moonshot-v1-8k',
                    configured: getEnvState(process.env.KIMI_API_KEY) === 'set'
                },
                fallbackApi: {
                    provider: 'KIMI',
                    configured: getEnvState(process.env.KIMI_API_KEY) === 'set'
                }
            });
        }

        if (req.method === 'GET' && pathname === '/api/files') {
            return sendJson(res, 200, { files: listDocumentFiles() });
        }

        if (req.method === 'POST' && pathname === '/api/search') {
            const { question } = await readJsonBody(req);
            if (typeof question !== 'string' || !question.trim()) return sendJson(res, 400, { error: '검색어를 입력해주세요.' });
            const docs = keywordSearch(question.trim(), 6);
            return sendJson(res, 200, {
                results: docs.map(doc => ({
                    source: doc.metadata?.source || '문서',
                    retrieval: doc.metadata?.retrieval || 'keyword',
                    score: doc.metadata?.score,
                    preview: String(doc.pageContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
                }))
            });
        }

        if (req.method === 'POST' && pathname === '/api/ask') {
            const { question } = await readJsonBody(req);
            if (typeof question !== 'string' || !question.trim()) return sendJson(res, 400, { error: '질문을 입력해주세요.' });
            const docs = keywordSearch(question.trim(), 8);
            if (docs.length === 0) {
                return sendJson(res, 200, {
                    answer: knowledgeNotFoundMessage,
                    sources: [],
                    provider: 'local-extractive',
                    model: 'keyword-search',
                    fallback: { used: true, from: 'kimi', to: 'web-local-rag', reason: 'no-retrieved-chunks' },
                    notice: fallbackNotice
                });
            }

            const sources = [...new Set(docs.map(doc => doc.metadata?.source || '문서'))];
            try {
                const kimiResponse = await generateKimiAnswer(buildRagPrompt(question.trim(), docs));
                const normalized = normalizeKimiAnswer(kimiResponse.content, sources);
                return sendJson(res, 200, {
                    answer: normalized.answer,
                    sources: normalized.sources,
                    provider: kimiResponse.provider,
                    model: kimiResponse.model,
                    fallback: { used: false, from: null, to: null, reason: null },
                    notice: apiNotice
                });
            } catch (error) {
                console.warn(`KIMI API 실패, 웹 로직 fallback 전환: ${error.message}`);
            }

            const result = buildExtractiveAnswer(docs, question.trim());
            return sendJson(res, 200, {
                answer: result.answer,
                sources: result.sources,
                provider: 'local-extractive',
                model: 'keyword-search',
                fallback: { used: true, from: 'kimi', to: 'web-local-rag', reason: 'kimi-api-failed' },
                notice: fallbackNotice
            });
        }

        if (req.method === 'POST' && pathname === '/api/ingest') {
            const result = await ingestDocuments();
            return sendJson(res, 200, result);
        }

        if (req.method === 'GET') return serveStatic(req, res, pathname);

        return sendJson(res, 405, { error: '허용되지 않은 메서드입니다.' });
    } catch (error) {
        console.error(error);
        return sendJson(res, 500, { error: error.message });
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log('===============================================');
    console.log('Local-First RAG fast server ready');
    console.log(`URL: http://127.0.0.1:${port}`);
    console.log('===============================================');
});
