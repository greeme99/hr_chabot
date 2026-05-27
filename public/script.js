const dom = {
    chatContainer: document.getElementById('chat-container'),
    messageInput: document.getElementById('message-input'),
    sendBtn: document.getElementById('send-btn'),
    docList: document.getElementById('doc-list'),
    systemStatus: document.getElementById('system-status'),
    refreshDocsBtn: document.getElementById('refresh-docs-btn'),
    toast: document.getElementById('toast'),
    toastMessage: document.getElementById('toast-message'),
    toastIcon: document.getElementById('toast-icon'),
    loadingOverlay: document.getElementById('loading-overlay')
};

const API_BASE_URL = window.location.protocol === 'file:'
    ? 'http://127.0.0.1:3000'
    : '';

function apiUrl(path) {
    return `${API_BASE_URL}${path}`;
}

function showToast(message, type = 'info') {
    dom.toastMessage.textContent = message;
    dom.toastIcon.textContent = type === 'error' ? '❌' : type === 'success' ? '✅' : 'ℹ️';
    dom.toast.classList.remove('opacity-0', 'pointer-events-none');
    setTimeout(() => {
        dom.toast.classList.add('opacity-0', 'pointer-events-none');
    }, 3000);
}

function scrollToBottom() {
    dom.chatContainer.scrollTo({
        top: dom.chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatMarkdown(text) {
    let formatted = escapeHtml(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
    return `<p>${formatted}</p>`;
}

function appendMessage(role, content, source = null, notice = null, noticeType = 'api') {
    const isUser = role === 'user';
    const wrapper = document.createElement('div');
    wrapper.className = `flex flex-col gap-1 w-full ${isUser ? 'items-end' : 'items-start'} max-w-3xl ${isUser ? 'ml-auto' : ''}`;
    
    const bubble = document.createElement('div');
    bubble.className = `p-4 flex-1 rounded-2xl shadow-sm text-[15px] ${
        isUser 
        ? 'bg-primary text-white rounded-tr-sm' 
        : 'bg-surface border border-gray-200 text-text rounded-tl-sm ai-message-content w-full'
    }`;
    
    if (isUser) {
        bubble.textContent = content; 
    } else {
        if (notice && notice.trim() !== '') {
            const noticeDiv = document.createElement('div');
            noticeDiv.className = `mode-notice ${noticeType === 'fallback' ? 'is-fallback' : 'is-api'}`;
            noticeDiv.textContent = notice;
            bubble.appendChild(noticeDiv);
        }

        const answerDiv = document.createElement('div');
        answerDiv.innerHTML = formatMarkdown(content);
        bubble.appendChild(answerDiv);
        
        if (source && source.trim() !== '') {
            const sourceDiv = document.createElement('div');
            sourceDiv.className = 'mt-3 pt-3 border-t border-gray-100';
            const chip = document.createElement('div');
            chip.className = 'source-chip';
            chip.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414A1 1 0 0120 9.414V19a2 2 0 01-2 2z" /></svg>';
            const sourceText = document.createElement('span');
            sourceText.textContent = `참고문서: ${source}`;
            chip.appendChild(sourceText);
            // 툴팁 등은 프로토타입 범위 밖이므로 단순히 표시
            sourceDiv.appendChild(chip);
            bubble.appendChild(sourceDiv);
        }
    }
    
    wrapper.appendChild(bubble);
    dom.chatContainer.appendChild(wrapper);
    scrollToBottom();
}

function showTypingIndicator() {
    const wrapper = document.createElement('div');
    wrapper.id = 'typing-indicator';
    wrapper.className = `flex flex-col gap-1 items-start max-w-3xl`;
    const bubble = document.createElement('div');
    bubble.className = `p-4 rounded-2xl bg-surface border border-gray-200 shadow-sm rounded-tl-sm`;
    const indicator = document.createElement('div');
    indicator.className = 'typing-indicator py-1';
    indicator.innerHTML = '<span></span><span></span><span></span>';
    bubble.appendChild(indicator);
    wrapper.appendChild(bubble);
    dom.chatContainer.appendChild(wrapper);
    scrollToBottom();
}

function removeTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

async function fetchDocsList() {
    try {
        const res = await fetch(apiUrl('/api/files'));
        const data = await res.json();
        
        dom.docList.innerHTML = '';
        if (data.files && data.files.length > 0) {
            data.files.forEach(file => {
                const li = document.createElement('li');
                li.className = 'flex items-center gap-2 text-sm text-gray-700 py-2 px-2 hover:bg-gray-100 rounded-lg transition-colors cursor-default';
                li.innerHTML = `
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-primary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <span class="truncate">${file}</span>
                `;
                dom.docList.appendChild(li);
            });
        } else {
            dom.docList.innerHTML = '<li class="text-sm text-gray-500 italic py-2 px-2">학습된 문서가 없습니다. 우측 상단의 새로고침 버튼을 눌러주세요.</li>';
        }
    } catch (error) {
        dom.docList.innerHTML = `
            <li class="text-sm text-red-500 py-2 px-2">
                서버 연결 오류<br>
                <span class="text-xs text-gray-500">터미널에서 npm start 실행 후 다시 시도하세요.</span>
            </li>
        `;
    }
}

async function fetchSystemStatus() {
    if (!dom.systemStatus) return;
    try {
        const res = await fetch(apiUrl('/api/status'));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '상태 조회 실패');

        const fallbackText = data.anythingLlm.configured ? '준비됨' : '설정 필요';
        const fallbackClass = data.anythingLlm.configured ? 'text-green-700' : 'text-amber-700';
        dom.systemStatus.innerHTML = `
            <div class="flex justify-between gap-2"><span>인덱스 청크</span><strong>${data.vectorStore.chunksCount}</strong></div>
            <div class="flex justify-between gap-2"><span>지원 문서</span><strong>${data.documents.supportedCount}</strong></div>
            <div class="flex justify-between gap-2"><span>AnythingLLM</span><strong class="${fallbackClass}">${fallbackText}</strong></div>
        `;
    } catch (error) {
        dom.systemStatus.innerHTML = `
            <div class="text-red-600 font-semibold">서버 연결 필요</div>
            <div class="text-gray-500">API: ${API_BASE_URL || window.location.origin}</div>
        `;
    }
}

async function ingestDocs() {
    dom.loadingOverlay.classList.remove('hidden');
    dom.loadingOverlay.classList.add('flex');
    try {
        const res = await fetch(apiUrl('/api/ingest'), { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(`${data.message}`, 'success');
            fetchDocsList();
            fetchSystemStatus();
        } else {
            showToast(data.error || '문서 인덱싱 실패', 'error');
        }
    } catch (error) {
        showToast('서버 연결 오류: npm start 실행이 필요합니다.', 'error');
    } finally {
        dom.loadingOverlay.classList.add('hidden');
        dom.loadingOverlay.classList.remove('flex');
    }
}

async function sendMessage() {
    const text = dom.messageInput.value.trim();
    if (!text) return;
    
    appendMessage('user', text);
    dom.messageInput.value = '';
    dom.messageInput.style.height = 'auto';
    dom.sendBtn.disabled = true;
    showTypingIndicator();
    
    try {
        const res = await fetch(apiUrl('/api/ask'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: text })
        });
        
        const data = await res.json();
        removeTypingIndicator();
        
        if (res.ok) {
            let answerText = data.answer;
            let source = data.sources && data.sources.length > 0 ? [...new Set(data.sources.map(s => s.split(/[\\/]/).pop()))].join(", ") : null;
            
            // 프롬프트 강제에 의한 출처 텍스트가 응답 본문에 있을 경우 추출 (예: 참고: [filename.pdf])
            const sourceRegex = /출처\s*:\s*\[(.*?)\]|참고\s*:\s*\[(.*?)\]/g;
            let match;
            let inlineSources = [];
            while ((match = sourceRegex.exec(answerText)) !== null) {
                inlineSources.push(match[1] || match[2]);
            }
            if (inlineSources.length > 0) {
                source = inlineSources.join(", ");
                // 정규식으로 찾은 출처 텍스트를 응답 본문에서 제거
                answerText = answerText.replace(/출처\s*:\s*\[(.*?)\]|참고\s*:\s*\[(.*?)\]/g, '').trim();
            }

            const answerLines = answerText.split('\n');
            const referenceLines = answerLines.filter(line => line.trim().startsWith('참고:'));
            if (referenceLines.length > 0 && !source) {
                source = referenceLines
                    .map(line => line.replace(/^참고\s*:\s*/, '').trim())
                    .filter(Boolean)
                    .join(', ');
            }
            answerText = answerLines.filter(line => !line.trim().startsWith('참고:')).join('\n').trim();

            appendMessage('ai', answerText, source, data.notice, data.fallback?.used ? 'fallback' : 'api');
        } else {
            appendMessage('ai', `오류가 발생했습니다: ${data.error}`);
        }
    } catch (error) {
        removeTypingIndicator();
        appendMessage('ai', '서버와 통신할 수 없습니다. 터미널에서 npm start를 실행한 뒤 다시 시도해주세요.');
    } finally {
        dom.sendBtn.disabled = false;
        dom.messageInput.focus();
    }
}

dom.messageInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

dom.messageInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

dom.sendBtn.addEventListener('click', sendMessage);
dom.refreshDocsBtn.addEventListener('click', ingestDocs);

window.addEventListener('DOMContentLoaded', () => {
    fetchDocsList();
    fetchSystemStatus();
});
