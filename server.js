require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const stripDataUris = (text) => String(text || '').replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, ' ');
const formatDocumentsAsString = (docs) => docs.map((doc) => stripDataUris(doc.pageContent)).join("\n\n");
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.tsv', '.txt', '.md', '.markdown']);
const EMBEDDING_BATCH_SIZE = Number(process.env.EMBEDDING_BATCH_SIZE || 8);

// Gemini 2.5 Flash 직접 구현 클래스
class Gemini25FlashChat {
    constructor(options = {}) {
        this.apiKey = options.apiKey || process.env.GOOGLE_API_KEY;
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        this.client = new GoogleGenerativeAI(this.apiKey);
        // Gemini 2.5 Flash의 실제 API ID (gemini-1.5-flash는 2025년 EOL)
        this.modelName = options.model || "gemini-2.5-flash";
        this.apiVersion = options.apiVersion || "v1"; // Gemini 2.5 Flash는 v1 API 사용
    }

    async invoke(messages) {
        const model = this.client.getGenerativeModel(
            { model: this.modelName },
            { apiVersion: this.apiVersion }
        );

        // 메시지 변환 (LangChain 형식 -> Gemini 형식)
        const contents = messages.map(msg => ({
            role: msg._getType() === "human" ? "user" : "model",
            parts: [{ text: msg.content }]
        }));

        const result = await model.generateContent({ contents });
        const response = result.response;
        const text = response.text();

        return { content: text, provider: 'gemini', model: this.modelName };
    }
}

class AnythingLlmChat {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || process.env.ANYTHINGLLM_API_BASE || 'http://127.0.0.1:3001').replace(/\/$/, '');
        this.apiKey = options.apiKey || process.env.ANYTHINGLLM_API_KEY;
        this.workspaceSlug = options.workspaceSlug || process.env.ANYTHINGLLM_WORKSPACE_SLUG;
        this.mode = options.mode || process.env.ANYTHINGLLM_MODE || 'chat';
        this.sessionId = options.sessionId || process.env.ANYTHINGLLM_SESSION_ID || 'local-knowledge-bot-fallback';
    }

    async invoke(messages) {
        if (!this.apiKey) {
            throw new Error('ANYTHINGLLM_API_KEY가 설정되지 않았습니다.');
        }
        if (!this.workspaceSlug) {
            throw new Error('ANYTHINGLLM_WORKSPACE_SLUG가 설정되지 않았습니다.');
        }

        const prompt = messages.map(msg => msg.content).join('\n\n');
        const response = await fetch(`${this.baseUrl}/api/v1/workspace/${encodeURIComponent(this.workspaceSlug)}/chat`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: prompt,
                mode: this.mode,
                sessionId: this.sessionId,
                enable_thinking: false
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`AnythingLLM 응답 생성 실패: ${response.status} ${response.statusText} ${errorText}`);
        }

        const data = await response.json();
        const text = data?.textResponse || data?.response || data?.text || data?.message;
        if (!text) {
            throw new Error('AnythingLLM 응답 본문이 비어 있습니다.');
        }
        return { content: text, provider: 'anythingllm', model: this.workspaceSlug };
    }
}

/**
 * 로컬 RAG 지식봇 - Gemini API 기반
 *
 * 모델 구성:
 * - 임베딩: gemini-embedding-001 (현재 가장 권장되는 안정화된 텍스트 전용 임베딩 모델)
 * - 채팅: Gemini 2.5 Flash (실시간 응답이 필요한 고객 응대용 챗봇의 표준 모델)
 *
 * 특징:
 * - 로컬 벡터 저장소 (HNSWLib)
 * - PDF 문서 기반 RAG
 * - 안전한 로컬-first 아키텍처
 */

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin(origin, callback) {
        const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
        if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS origin not allowed: ${origin}`));
    },
}));
app.use(express.json({ limit: '64kb' }));
app.use(express.static('public'));

const DOCUMENTS_DIR = path.join(__dirname, 'documents');
const STORAGE_DIR = path.join(__dirname, 'storage');
const CHUNKS_PATH = path.join(STORAGE_DIR, 'chunks.json');
const KNOWLEDGE_NOT_FOUND_MESSAGE = "해당 내용은 지식DB에 없습니다";
const API_ANSWER_NOTICE = "API로 먼저 봇 질문에 대응했습니다.";
const WEB_FALLBACK_NOTICE = "API 연결 실패로 웹 로직 fallback으로 전환하여 지식DB 청크 저장소 기준으로 답변했습니다.";
const QUERY_STOPWORDS = new Set([
    '내용', '내용은', '핵심', '요약', '정리', '설명', '설명해줘', '알려줘',
    '무엇', '무엇인가요', '뭔가요', '어떻게', '되나요', '인가요', '주세요'
]);
const RAG_SYSTEM_INSTRUCTIONS = `
당신은 회사의 규정, 지침, 지식을 제공하는 챗봇입니다.
사용자가 지식 DB의 범위에 해당하는 질문을 하면 문맥에 기반하여 답변하고 인용 문서를 알려주세요.

유일한 정보원은 RAG 형식으로 제공되는 문서청크 저장소입니다.
반드시 다음 원칙을 지키세요.
- 청크 저장소에 명시된 내용만 사용해 답변합니다.
- 인용한 문서가 복수일 경우, 전부 표시합니다.
- 청크 저장소에 있는 내용은 찾아서 해당 내용만 답변합니다.
- "자세한 내용은 사내 관련 문서를 참고하시거나, ~와 관련된 자세한 사항은 담당자에게 문의하시기 바랍니다" 등의 부연 문구는 절대 추가하지 않습니다.
- 문서에 근거가 없거나, 지식DB(규정, 지침, 지식)와 직접적으로 연결할 수 없는 내용은 절대 추측하거나 일반 상식으로 보충하지 않습니다.
- 사용자의 질문에 대해 관련 정보를 찾지 못한 경우, 정확히 "${KNOWLEDGE_NOT_FOUND_MESSAGE}"라고 답합니다.
- 사용자의 주장이나 정보가 규정과 다를 경우, 다음 형식으로 답합니다: "문의하신 내용은 규정과 다릅니다. 지식DB에 따르면 (규정 내용을 간단히 요약해서 설명)"
- 규정의 표현을 왜곡하지 말고, 핵심 문장을 요약하여 설명하되, 필요하면 원문의 표현도 함께 제시합니다.
- 규정에 없는 부가적인 조언(개인적 의견, 관행, 추정)은 하지 않습니다.
- 답변 마지막에는 인용 문서를 "참고: 문서명1, 문서명2" 형식으로 표시합니다.
`.trim();

// Create directories if they don't exist
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR);
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR);

let vectorStore = null;

function createGoogleEmbeddings() {
    const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
    const { GoogleGenerativeAI, TaskType } = require("@google/generative-ai");

    class CustomGoogleGenerativeAIEmbeddings extends GoogleGenerativeAIEmbeddings {
        constructor(fields) {
            super(fields);
            this.client = new GoogleGenerativeAI(this.apiKey).getGenerativeModel(
                { model: "gemini-embedding-001" },
                { baseUrl: fields?.baseUrl, apiVersion: "v1beta" }
            );
            console.log('Custom client created with model: gemini-embedding-001, apiVersion: v1beta');
        }
    }

    return new CustomGoogleGenerativeAIEmbeddings({
        apiKey: process.env.GOOGLE_API_KEY,
        modelName: "embedding-001",
        taskType: TaskType.RETRIEVAL_DOCUMENT,
        stripNewLines: true,
    });
}

function isSupportedDocument(file) {
    return SUPPORTED_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function getEnvState(value) {
    if (value === undefined) return 'missing';
    if (value === '') return 'empty';
    if (/your_|_here|workspace_slug|발급받은/i.test(value)) return 'placeholder';
    return 'set';
}

function getStoredChunkCount() {
    const docstorePath = path.join(STORAGE_DIR, 'docstore.json');
    if (!fs.existsSync(docstorePath)) return 0;
    try {
        const data = JSON.parse(fs.readFileSync(docstorePath, 'utf8'));
        return Array.isArray(data) ? data.length : Object.keys(data).length;
    } catch (error) {
        console.warn("docstore.json 청크 수 확인 실패:", error.message);
        return 0;
    }
}

function saveAllChunks(docs) {
    const payload = docs.map((doc, index) => ({
        id: index,
        pageContent: doc.pageContent,
        metadata: doc.metadata || {}
    }));
    fs.writeFileSync(CHUNKS_PATH, JSON.stringify(payload, null, 2), 'utf8');
}

function clearVectorStoreFiles() {
    for (const file of ['hnswlib.index', 'docstore.json', 'args.json']) {
        const filePath = path.join(STORAGE_DIR, file);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
}

function loadAllChunks() {
    if (!fs.existsSync(CHUNKS_PATH)) return [];
    try {
        return JSON.parse(fs.readFileSync(CHUNKS_PATH, 'utf8'));
    } catch (error) {
        console.warn("chunks.json 로드 실패:", error.message);
        return [];
    }
}

function getStoredAllChunkCount() {
    return loadAllChunks().length;
}

function getStoredSourceStats() {
    const allChunks = loadAllChunks();
    if (allChunks.length > 0) {
        return allChunks.reduce((acc, doc) => {
            const source = doc?.metadata?.source || 'unknown';
            acc[source] = (acc[source] || 0) + 1;
            return acc;
        }, {});
    }

    const docstorePath = path.join(STORAGE_DIR, 'docstore.json');
    if (!fs.existsSync(docstorePath)) return {};
    try {
        const data = JSON.parse(fs.readFileSync(docstorePath, 'utf8'));
        const docs = Array.isArray(data) ? data.map(item => item[1] || item) : Object.values(data);
        return docs.reduce((acc, doc) => {
            const source = doc?.metadata?.source || 'unknown';
            acc[source] = (acc[source] || 0) + 1;
            return acc;
        }, {});
    } catch (error) {
        console.warn("docstore.json 소스 통계 확인 실패:", error.message);
        return {};
    }
}

function tokenize(text) {
    return String(text || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_.-]/gu, ' ')
        .split(/\s+/)
        .map(token => token.trim())
        .filter(token => token.length >= 2)
        .filter(token => !QUERY_STOPWORDS.has(token));
}

function keywordSearch(question, k = 4) {
    const chunks = loadAllChunks();
    if (chunks.length === 0) return [];

    const queryTokens = tokenize(question);
    const normalizedQuestion = String(question || '').normalize('NFC').toLowerCase();
    const preferredSourceHints = [];
    if (normalizedQuestion.includes('코칭') || normalizedQuestion.includes('gps')) {
        preferredSourceHints.push('코칭', 'gps');
    }
    if (normalizedQuestion.includes('경쟁사') || normalizedQuestion.includes('경쟁사분석')) {
        preferredSourceHints.push('경쟁사');
    }

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
        if (normalizedQuestion.toLowerCase().includes('gps') && source.includes('gps')) score += 20;
        if (normalizedQuestion.includes('경쟁사') && source.includes('경쟁사')) score += 25;
        if (normalizedQuestion.includes('분석') && source.includes('분석')) score += 10;

        return { chunk, score, contentScore };
    });

    const allPositive = scored
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score);
    const contentPositive = scored
        .filter(item => item.contentScore > 0)
        .sort((a, b) => b.score - a.score);
    const positive = contentPositive.length > 0 ? contentPositive : allPositive;

    const sourceFocused = preferredSourceHints.length > 0
        ? positive.filter(item => {
            const source = String(item.chunk.metadata?.source || '').normalize('NFC').toLowerCase();
            return preferredSourceHints.some(hint => source.includes(hint));
        })
        : [];

    const selected = (sourceFocused.length > 0 ? sourceFocused : positive).slice(0, k);

    return selected
        .map(item => ({
            pageContent: item.chunk.pageContent,
            metadata: { ...item.chunk.metadata, retrieval: 'keyword', score: item.score }
        }));
}

function mergeRetrievedDocs(primaryDocs, secondaryDocs, limit = 6) {
    const merged = [];
    const seen = new Set();

    for (const doc of [...primaryDocs, ...secondaryDocs]) {
        const key = `${doc.metadata?.source || ''}:${doc.pageContent.slice(0, 120)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(doc);
        if (merged.length >= limit) break;
    }

    return merged;
}

async function retrieveRelevantDocs(question, limit = 6) {
    const keywordDocs = keywordSearch(question, Math.min(4, limit));
    if (keywordDocs.length === 0) {
        return [];
    }

    let vectorDocs = [];
    if (vectorStore) {
        const retriever = vectorStore.asRetriever({ k: Math.min(4, limit) });
        const keywordSources = new Set(keywordDocs.map(doc => doc.metadata?.source || ''));
        vectorDocs = (await retriever.invoke(question)).filter(doc => keywordSources.has(doc.metadata?.source || ''));
    }
    return mergeRetrievedDocs(keywordDocs, vectorDocs, limit);
}

function buildExtractiveAnswer(question, docs) {
    if (docs.length === 0) {
        return KNOWLEDGE_NOT_FOUND_MESSAGE;
    }

    const sources = [...new Set(docs.map(doc => doc.metadata?.source || '문서'))];
    const snippets = docs.slice(0, 4).map((doc, index) => {
        const text = String(doc.pageContent || '')
            .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 550);
        return `${index + 1}. ${text}`;
    });

    return [
        ...snippets,
        "",
        `참고: ${sources.join(', ')}`
    ].join("\n");
}

function normalizeKnowledgeAnswer(answer, sources) {
    const text = String(answer || '').trim();
    if (text.includes(KNOWLEDGE_NOT_FOUND_MESSAGE)) {
        return { answer: KNOWLEDGE_NOT_FOUND_MESSAGE, sources: [] };
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

function cleanExtractedText(text, ext) {
    let cleaned = stripDataUris(String(text || '').replace(/\u0000/g, ' '));
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

async function loadPdfDocuments(filePath, file) {
    const { PDFLoader } = require("@langchain/community/document_loaders/fs/pdf");
    const loader = new PDFLoader(filePath);
    const docs = await loader.load();
    return docs.map((doc, index) => ({
        pageContent: cleanExtractedText(doc.pageContent, '.pdf'),
        metadata: { source: file, type: 'pdf', section: index + 1 }
    }));
}

async function loadDocxDocuments(filePath, file) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return [{
        pageContent: cleanExtractedText(result.value, '.docx'),
        metadata: { source: file, type: 'docx' }
    }];
}

function loadSpreadsheetDocuments(filePath, file) {
    const XLSX = require('xlsx');
    const workbook = XLSX.readFile(filePath, { cellDates: true });
    return workbook.SheetNames.map(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t', blankrows: false });
        return {
            pageContent: cleanExtractedText(csv, path.extname(file).toLowerCase()),
            metadata: { source: file, type: path.extname(file).slice(1).toLowerCase(), sheet: sheetName }
        };
    });
}

async function loadTextDocuments(filePath, file) {
    const ext = path.extname(file).toLowerCase();
    const content = await fs.promises.readFile(filePath, 'utf8');
    return [{
        pageContent: cleanExtractedText(content, ext),
        metadata: { source: file, type: ext.slice(1).toLowerCase() }
    }];
}

async function loadDocument(filePath, file) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.pdf') return loadPdfDocuments(filePath, file);
    if (ext === '.docx') return loadDocxDocuments(filePath, file);
    if (['.xlsx', '.xls', '.csv', '.tsv'].includes(ext)) return loadSpreadsheetDocuments(filePath, file);
    if (['.txt', '.md', '.markdown'].includes(ext)) return loadTextDocuments(filePath, file);
    return [];
}

async function generateAnswerWithFallback(fullPrompt) {
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'your_api_key_here') {
        console.warn('GOOGLE_API_KEY가 없어 Gemini 호출을 건너뛰고 AnythingLLM fallback을 시도합니다.');
    } else {
        const gemini = new Gemini25FlashChat({
            apiKey: process.env.GOOGLE_API_KEY,
            model: process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash",
            apiVersion: process.env.GEMINI_API_VERSION || "v1"
        });

        try {
            return await gemini.invoke([{ _getType: () => "human", content: fullPrompt }]);
        } catch (error) {
            console.warn(`Gemini 응답 생성 실패, AnythingLLM fallback 시도: ${error.message}`);
        }
    }

    const anythingLlm = new AnythingLlmChat();
    try {
        return await anythingLlm.invoke([{ _getType: () => "human", content: fullPrompt }]);
    } catch (error) {
        console.error(`AnythingLLM fallback 실패: ${error.message}`);
        throw new Error('Gemini API 실패 후 AnythingLLM fallback도 실패했습니다. ANYTHINGLLM_API_BASE, ANYTHINGLLM_API_KEY, ANYTHINGLLM_WORKSPACE_SLUG, AnythingLLM 서버 상태를 확인해주세요.');
    }
}

async function embedDocumentsSafely(embeddings, texts, batchSize = EMBEDDING_BATCH_SIZE) {
    const vectors = new Array(texts.length);

    for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        let batchVectors = [];
        try {
            batchVectors = await embeddings.embedDocuments(batch);
        } catch (error) {
            console.warn(`배치 임베딩 실패(start=${start}, size=${batch.length}), 개별 재시도:`, error.message);
            batchVectors = [];
        }

        for (let i = 0; i < batch.length; i += 1) {
            const vector = batchVectors[i];
            if (Array.isArray(vector) && vector.length > 0) {
                vectors[start + i] = vector;
                continue;
            }

            try {
                const retryVectors = await embeddings.embedDocuments([batch[i]]);
                vectors[start + i] = retryVectors[0];
            } catch (error) {
                console.warn(`개별 임베딩 재시도 실패(index=${start + i}):`, error.message);
                vectors[start + i] = [];
            }
        }
    }

    return vectors.map(vector => Array.isArray(vector) ? vector : []);
}

// Initialize Vector Store from local storage if exists
async function initVectorStore() {
    try {
        if (!process.env.GOOGLE_API_KEY) {
            console.warn("API Key warning: .env 파일에 GOOGLE_API_KEY가 설정되지 않았습니다.");
            return;
        }

        const embeddings = createGoogleEmbeddings();

        if (fs.existsSync(path.join(STORAGE_DIR, 'hnswlib.index'))) {
            const { HNSWLib } = require("@langchain/community/vectorstores/hnswlib");
            console.log("기존 로컬 벡터 저장소를 로드합니다...");
            vectorStore = await HNSWLib.load(STORAGE_DIR, embeddings);
            console.log("로컬 벡터 저장소 로드 완료.");
        }
    } catch (e) {
        console.error("벡터 저장소 초기화 실패:", e);
    }
}
// initVectorStore()는 app.listen 내에서 호출됨


// API: 학습된 파일 목록 조회
app.get('/api/files', (req, res) => {
    try {
        if (!fs.existsSync(DOCUMENTS_DIR)) {
            return res.json({ files: [] });
        }
        const files = fs.readdirSync(DOCUMENTS_DIR).filter(isSupportedDocument);
        res.json({ files });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: 현재 서버/설정/인덱스 상태 조회
app.get('/api/status', (req, res) => {
    try {
        const documentFiles = fs.existsSync(DOCUMENTS_DIR)
            ? fs.readdirSync(DOCUMENTS_DIR).filter(isSupportedDocument)
            : [];
        const anythingLlm = {
            apiBase: process.env.ANYTHINGLLM_API_BASE || 'http://127.0.0.1:3001',
            apiKeyState: getEnvState(process.env.ANYTHINGLLM_API_KEY),
            workspaceSlugState: getEnvState(process.env.ANYTHINGLLM_WORKSPACE_SLUG),
            mode: process.env.ANYTHINGLLM_MODE || 'chat',
            configured: getEnvState(process.env.ANYTHINGLLM_API_KEY) === 'set'
                && getEnvState(process.env.ANYTHINGLLM_WORKSPACE_SLUG) === 'set'
        };

        res.json({
            server: { ready: true, port },
            vectorStore: { loaded: Boolean(vectorStore), chunksCount: vectorStore ? getStoredChunkCount() : 0 },
            chunkStore: { loaded: getStoredAllChunkCount() > 0, chunksCount: getStoredAllChunkCount() },
            sources: getStoredSourceStats(),
            documents: {
                supportedCount: documentFiles.length,
                supportedExtensions: Array.from(SUPPORTED_EXTENSIONS)
            },
            gemini: {
                apiKeyState: getEnvState(process.env.GOOGLE_API_KEY),
                model: process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash',
                apiVersion: process.env.GEMINI_API_VERSION || 'v1'
            },
            anythingLlm
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: 폴더 내 문서 읽어 벡터 DB화 (로컬 인덱싱)
app.post('/api/ingest', async (req, res) => {
    if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY === 'your_api_key_here') {
        return res.status(500).json({ error: "서버의 .env 파일에 올바른 GOOGLE_API_KEY를 설정해야 합니다." });
    }

    try {
        const files = fs.readdirSync(DOCUMENTS_DIR).filter(isSupportedDocument);
        if (files.length === 0) {
            return res.status(400).json({ error: "/documents 폴더에 PDF, DOCX, Excel, TXT, MD 문서가 없습니다." });
        }

        const documents = [];
        const fileStats = {};
        const skippedFiles = [];
        for (const file of files) {
            const filePath = path.join(DOCUMENTS_DIR, file);
            const docs = await loadDocument(filePath, file);

            const readableDocs = docs.filter(doc => doc.pageContent && doc.pageContent.trim().length > 0);
            fileStats[file] = {
                sections: docs.length,
                readableSections: readableDocs.length,
                extractedChars: readableDocs.reduce((sum, doc) => sum + doc.pageContent.trim().length, 0),
                chunks: 0,
                indexedChunks: 0,
                skippedChunks: 0
            };
            if (readableDocs.length === 0) {
                skippedFiles.push(file);
                continue;
            }

            for (const doc of readableDocs) {
                documents.push({
                    pageContent: doc.pageContent.trim(),
                    metadata: doc.metadata || { source: file }
                });
            }
        }

        if (documents.length === 0) {
            return res.status(422).json({
                error: "문서에서 추출 가능한 텍스트를 찾지 못했습니다. 스캔본/이미지 PDF라면 OCR 처리 후 다시 시도해주세요.",
                skippedFiles
            });
        }

        // 3. 청킹
        const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });

        const splitDocs = await textSplitter.createDocuments(
            documents.map(d => d.pageContent),
            documents.map(d => d.metadata)
        );

        for (const doc of splitDocs) {
            const source = doc.metadata?.source || 'unknown';
            if (!fileStats[source]) {
                fileStats[source] = { sections: 0, readableSections: 0, extractedChars: 0, chunks: 0, indexedChunks: 0, skippedChunks: 0 };
            }
            fileStats[source].chunks += 1;
        }

        if (splitDocs.length === 0) {
            return res.status(422).json({
                error: "문서 텍스트를 청크로 분할하지 못했습니다.",
                skippedFiles
            });
        }

        saveAllChunks(splitDocs);

        // 4. 임베딩(이 과정만 구글 API 활용) 후 HNSWLib(로컬) 저장
        const embeddings = createGoogleEmbeddings();

        const vectors = await embedDocumentsSafely(embeddings, splitDocs.map(doc => doc.pageContent));
        const validVectors = [];
        const validDocs = [];
        let skippedChunksCount = 0;
        let expectedDimensions = null;

        for (let i = 0; i < vectors.length; i += 1) {
            const vector = vectors[i];
            if (!Array.isArray(vector) || vector.length === 0) {
                skippedChunksCount += 1;
                const source = splitDocs[i].metadata?.source || 'unknown';
                if (fileStats[source]) fileStats[source].skippedChunks += 1;
                continue;
            }
            if (expectedDimensions === null) {
                expectedDimensions = vector.length;
            }
            if (vector.length !== expectedDimensions) {
                skippedChunksCount += 1;
                const source = splitDocs[i].metadata?.source || 'unknown';
                if (fileStats[source]) fileStats[source].skippedChunks += 1;
                continue;
            }
            validVectors.push(vector);
            validDocs.push(splitDocs[i]);
            const source = splitDocs[i].metadata?.source || 'unknown';
            if (fileStats[source]) fileStats[source].indexedChunks += 1;
        }

        if (validVectors.length > 0 && expectedDimensions !== null) {
            const { HNSWLib } = require("@langchain/community/vectorstores/hnswlib");
            vectorStore = new HNSWLib(embeddings, {
                space: "cosine",
                numDimensions: expectedDimensions
            });
            await vectorStore.addVectors(validVectors, validDocs);
            // 클라우드가 아닌 로컬 storage 폴더에 물리적 파일로 저장
            await vectorStore.save(STORAGE_DIR);
        } else {
            vectorStore = null;
            clearVectorStoreFiles();
            console.warn("유효한 임베딩 벡터가 없어 키워드 검색 전용 청크 저장소만 생성했습니다.");
        }

        const warning = skippedFiles.length > 0
            ? ` 단, 텍스트 추출이 불가능한 ${skippedFiles.length}개 파일은 제외되었습니다.`
            : "";

        res.json({
            message: `총 ${files.length}개 파일 중 ${documents.length}개 페이지/시트/섹션을 ${splitDocs.length}개 청크로 로컬 인덱싱했습니다.${warning}`,
            documentsCount: files.length,
            indexedSectionsCount: documents.length,
            chunksCount: splitDocs.length,
            indexedChunksCount: validDocs.length,
            skippedChunksCount,
            skippedFiles,
            fileStats
        });
    } catch (error) {
        console.error("Ingest error:", error);
        res.status(500).json({ error: error.message });
    }
});

// API: 생성 모델 호출 없이 검색 결과만 진단
app.post('/api/search', async (req, res) => {
    const { question } = req.body;

    if (typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: "검색어를 입력해주세요." });
    }

    if (!vectorStore && getStoredAllChunkCount() === 0) {
        return res.status(400).json({ error: "학습된 문서가 없습니다. 좌측 사이드바의 새로고침 아이콘을 눌러주세요." });
    }

    try {
        const docs = await retrieveRelevantDocs(question.trim(), 6);
        res.json({
            results: docs.map(doc => ({
                source: doc.metadata?.source || '문서',
                retrieval: doc.metadata?.retrieval || 'vector',
                score: doc.metadata?.score,
                preview: String(doc.pageContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: 사용자 질의응답 처리 (RAG)
app.post('/api/ask', async (req, res) => {
    const { question } = req.body;
    
    if (typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: "질문을 입력해주세요." });
    }

    const normalizedQuestion = question.trim();
    if (normalizedQuestion.length > 4000) {
        return res.status(400).json({ error: "질문은 4,000자 이하로 입력해주세요." });
    }

    if (!vectorStore && getStoredAllChunkCount() === 0) {
        return res.status(400).json({ error: "학습된 문서가 없습니다. 좌측 사이드바의 새로고침 아이콘을 눌러주세요." });
    }

    try {
        // 1. 관련 문서 조각(Context) 정보 추출: 벡터 검색 + 키워드 검색 보강
        const retrievedDocs = await retrieveRelevantDocs(normalizedQuestion, 6);

        const contextStr = formatDocumentsAsString(retrievedDocs);
        const sourceFiles = [...new Set(retrievedDocs.map(doc => doc.metadata.source || '문서'))];

        if (retrievedDocs.length === 0) {
            return res.json({
                answer: KNOWLEDGE_NOT_FOUND_MESSAGE,
                sources: [],
                provider: 'local-extractive',
                model: 'keyword-search',
                fallback: {
                    used: true,
                    from: 'api',
                    to: 'web-local-rag',
                    reason: 'no-retrieved-chunks'
                },
                notice: WEB_FALLBACK_NOTICE
            });
        }

        // 2. 프롬프트 생성 (시스템 지시사항 강제 주입)
        const fullPrompt = `
[시스템 지침]
${RAG_SYSTEM_INSTRUCTIONS}

[문서청크 저장소]
${contextStr}

[사용자 질문]
${normalizedQuestion}
`;

        // Gemini 2.5 Flash로 직접 응답 생성
        let response;
        try {
            response = await generateAnswerWithFallback(fullPrompt);
        } catch (error) {
            response = {
                content: buildExtractiveAnswer(normalizedQuestion, retrievedDocs),
                provider: 'local-extractive',
                model: 'keyword-search',
                fallbackReason: error.message
            };
        }
        const normalizedAnswer = normalizeKnowledgeAnswer(response.content, sourceFiles);
        const usedWebFallback = response.provider === 'local-extractive';

        res.json({ 
            answer: normalizedAnswer.answer,
            sources: normalizedAnswer.sources,
            provider: response.provider,
            model: response.model,
            fallback: usedWebFallback
                ? {
                    used: true,
                    from: 'api',
                    to: 'web-local-rag',
                    reason: response.fallbackReason || 'api-failed'
                }
                : {
                    used: false,
                    from: null,
                    to: null,
                    reason: null
                },
            notice: usedWebFallback ? WEB_FALLBACK_NOTICE : API_ANSWER_NOTICE
        });

    } catch (error) {
        console.error("Ask error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, '127.0.0.1', async () => {
    console.log(`===============================================`);
    console.log(`🚀 보안: Local-First RAG 웹서버 활성화`);
    console.log(`🌐 접속 주소: http://127.0.0.1:${port}`);
    console.log(`===============================================`);
    
    console.log("서버가 요청을 받을 준비가 되었습니다.");
    if (process.env.LOAD_VECTOR_ON_STARTUP === 'true') {
        try {
            console.log("벡터 저장소 초기화 중...");
            await initVectorStore();
            console.log("로컬 벡터 저장소 초기화 완료.");
        } catch (err) {
            console.error("벡터 저장소 초기화 실패:", err);
        }
    }
});
