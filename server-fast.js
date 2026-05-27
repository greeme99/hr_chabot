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

function loadChunks() {
    if (!fs.existsSync(chunksPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(chunksPath, 'utf8'));
    } catch (error) {
        console.warn('chunks.json 로드 실패:', error.message);
        return [];
    }
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

function keywordSearch(question, limit = 6) {
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

        for (const token of queryTokens) {
            if (content.includes(token)) {
                score += 8;
                contentScore += 8;
            }
            if (source.includes(token)) score += 5;
        }
        if (normalizedQuestion.includes('코칭') && source.includes('코칭')) score += 20;
        if (normalizedQuestion.includes('gps') && source.includes('gps')) score += 20;
        if (normalizedQuestion.includes('경쟁사') && source.includes('경쟁사')) score += 25;
        if (normalizedQuestion.includes('분석') && source.includes('분석')) score += 10;

        return { chunk, score, contentScore };
    });

    const allPositive = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const contentPositive = scored.filter(item => item.contentScore > 0).sort((a, b) => b.score - a.score);
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

function buildExtractiveAnswer(docs) {
    if (docs.length === 0) return { answer: knowledgeNotFoundMessage, sources: [] };
    const sources = [...new Set(docs.map(doc => doc.metadata?.source || '문서'))];
    const snippets = docs.slice(0, 4).map((doc, index) => {
        const text = String(doc.pageContent || '').replace(/\s+/g, ' ').trim().slice(0, 550);
        return `${index + 1}. ${text}`;
    });
    return {
        answer: `${snippets.join('\n')}\n\n참고: ${sources.join(', ')}`,
        sources
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
                anythingLlm: {
                    apiBase: process.env.ANYTHINGLLM_API_BASE || 'http://127.0.0.1:3001',
                    apiKeyState: process.env.ANYTHINGLLM_API_KEY ? 'set' : 'missing',
                    workspaceSlugState: process.env.ANYTHINGLLM_WORKSPACE_SLUG ? 'set' : 'missing',
                    mode: process.env.ANYTHINGLLM_MODE || 'chat',
                    configured: Boolean(process.env.ANYTHINGLLM_API_KEY && process.env.ANYTHINGLLM_WORKSPACE_SLUG)
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
            const docs = keywordSearch(question.trim(), 6);
            const result = buildExtractiveAnswer(docs);
            const notFound = result.answer === knowledgeNotFoundMessage;
            return sendJson(res, 200, {
                answer: result.answer,
                sources: notFound ? [] : result.sources,
                provider: 'local-extractive',
                model: 'keyword-search',
                fallback: { used: true, from: 'api', to: 'web-local-rag', reason: notFound ? 'no-retrieved-chunks' : 'fast-local-server' },
                notice: notFound ? fallbackNotice : fallbackNotice
            });
        }

        if (req.method === 'POST' && pathname === '/api/ingest') {
            return sendJson(res, 501, { error: '빠른 로컬 서버에서는 문서 재학습을 지원하지 않습니다. 기존 청크 저장소로 질의응답은 가능합니다.' });
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
