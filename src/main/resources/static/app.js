(function () {
    'use strict';

    const state = {
        works: [],
        sections: [],
        currentWork: null,
        currentPage: 0,
        pageSize: 5,
        morphCache: {}
    };

    const $ = id => document.getElementById(id);
    const landing = $('landing');
    const reader = $('reader');
    const searchInput = $('searchInput');
    const searchResults = $('searchResults');
    const recentList = $('recentList');
    const recentWorks = $('recentWorks');
    const workTitle = $('workTitle');
    const sectionInfo = $('sectionInfo');
    const originalText = $('originalText');
    const translationText = $('translationText');
    const tooltip = $('tooltip');
    const loading = $('loading');
    const loadingText = $('loadingText');
    const prevBtn = $('prevBtn');
    const nextBtn = $('nextBtn');
    const backBtn = $('backBtn');

    function showLoading(msg) {
        loadingText.textContent = msg || 'Loading...';
        loading.classList.add('visible');
    }
    function hideLoading() { loading.classList.remove('visible'); }
    function showPage(page) {
        landing.classList.remove('active');
        reader.classList.remove('active');
        page.classList.add('active');
    }

    function esc(s) {
        const d = document.createElement('div');
        d.textContent = s || '';
        return d.innerHTML;
    }

    // --- LocalStorage ---
    function getRecent() {
        try { return JSON.parse(localStorage.getItem('greekReaderRecent') || '[]'); } catch { return []; }
    }
    function saveRecent(work, sectionIdx) {
        let recent = getRecent();
        recent = recent.filter(r => r.urn !== work.urn);
        recent.unshift({ ...work, lastSection: sectionIdx, timestamp: Date.now() });
        if (recent.length > 20) recent = recent.slice(0, 20);
        localStorage.setItem('greekReaderRecent', JSON.stringify(recent));
    }
    function renderRecent() {
        const recent = getRecent();
        if (recent.length === 0) { recentWorks.style.display = 'none'; return; }
        recentWorks.style.display = 'block';
        recentList.innerHTML = recent.map(r => `
            <div class="recent-item" data-urn="${esc(r.urn)}" data-section="${r.lastSection || 0}">
                <div>
                    <div class="recent-title">${esc(r.label)}</div>
                    <div class="recent-author">${esc(r.author || '')}</div>
                </div>
                <div class="recent-section">Section ${(r.lastSection || 0) + 1}</div>
            </div>
        `).join('');
    }

    // --- Parse CTS capabilities XML ---
    function parseXml(text) {
        return new DOMParser().parseFromString(text, 'text/xml');
    }

    async function fetchCapabilities() {
        showLoading('Loading library catalog...');
        try {
            const resp = await fetch('/api/capabilities');
            if (!resp.ok) throw new Error('Capabilities fetch failed');
            const text = await resp.text();
            const doc = parseXml(text);
            const works = [];

            // Iterate all elements since namespaces make querySelector unreliable
            const allEls = doc.getElementsByTagName('*');
            const textgroups = [];
            for (const el of allEls) {
                if (el.localName === 'textgroup') textgroups.push(el);
            }

            for (const tg of textgroups) {
                const groupUrn = tg.getAttribute('urn') || '';
                let author = '';
                for (const child of tg.children) {
                    if (child.localName === 'groupname') {
                        author = child.textContent.trim();
                        break;
                    }
                }
                author = author || groupUrn;

                // Find work elements (direct children)
                for (const child of tg.children) {
                    if (child.localName !== 'work') continue;
                    const workUrn = child.getAttribute('urn') || '';
                    const lang = child.getAttribute('xml:lang') || child.getAttribute('lang') || '';

                    let title = '';
                    for (const wChild of child.children) {
                        if (wChild.localName === 'title') {
                            title = wChild.textContent.trim();
                            break;
                        }
                    }
                    title = title || workUrn;

                    let origUrn = '';
                    let engUrn = '';

                    for (const wChild of child.children) {
                        if (wChild.localName === 'edition') {
                            origUrn = origUrn || (wChild.getAttribute('urn') || '');
                        }
                        if (wChild.localName === 'translation') {
                            const trLang = wChild.getAttribute('xml:lang') || wChild.getAttribute('lang') || '';
                            if (!engUrn || trLang === 'eng' || trLang === 'en') {
                                engUrn = wChild.getAttribute('urn') || '';
                            }
                        }
                    }

                    if (origUrn) {
                        works.push({
                            urn: workUrn, label: title, author: author,
                            lang: lang, origUrn: origUrn, engUrn: engUrn
                        });
                    }
                }
            }

            state.works = works;
        } catch (e) {
            console.error('Failed to fetch capabilities', e);
            loadPopularWorks();
        }
        hideLoading();
    }

    // --- Search ---
    function search(query) {
        if (!query || query.length < 2) { searchResults.classList.remove('visible'); return; }
        const q = query.toLowerCase();
        const matches = state.works.filter(w =>
            w.label.toLowerCase().includes(q) || w.author.toLowerCase().includes(q)
        ).slice(0, 30);

        if (matches.length === 0) {
            searchResults.innerHTML = '<div class="search-result-item"><em>No results found</em></div>';
        } else {
            searchResults.innerHTML = matches.map(w => `
                <div class="search-result-item" data-urn="${esc(w.urn)}">
                    <div class="work-name">${esc(w.label)}</div>
                    <div class="author">${esc(w.author)}${w.engUrn ? ' — translation available' : ''}</div>
                </div>
            `).join('');
        }
        searchResults.classList.add('visible');
    }

    // --- Open a work ---
    async function openWork(urn, startSection) {
        const work = state.works.find(w => w.urn === urn);
        if (!work) return;
        state.currentWork = work;
        showLoading('Loading sections...');

        try {
            // Try increasing levels to find leaf sections
            let refs = [];
            for (let level = 1; level <= 3; level++) {
                const resp = await fetch(`/api/reff?urn=${encodeURIComponent(work.origUrn)}&level=${level}`);
                const text = await resp.text();
                const doc = parseXml(text);
                const newRefs = [];
                const allEls = doc.getElementsByTagName('*');
                for (const el of allEls) {
                    if (el.localName === 'urn') {
                        newRefs.push(el.textContent.trim());
                    }
                }
                if (newRefs.length > 0) refs = newRefs;
                // If we got a reasonable number (>1) of refs, and they look like leaf nodes, stop
                if (newRefs.length > 1 && newRefs.length <= 500) break;
                if (newRefs.length > 500) break; // too many, use this level
            }

            if (refs.length === 0) {
                hideLoading();
                alert('No sections found for this work.');
                return;
            }

            state.sections = refs;
            state.currentPage = startSection ? Math.floor(startSection / state.pageSize) : 0;
            workTitle.textContent = `${work.author} — ${work.label}`;
            showPage(reader);
            await loadCurrentPage();
        } catch (e) {
            console.error('Failed to open work', e);
            hideLoading();
            alert('Failed to load work. The Perseus API may be unavailable.');
        }
    }

    // --- Load current page ---
    async function loadCurrentPage() {
        const start = state.currentPage * state.pageSize;
        const end = Math.min(start + state.pageSize, state.sections.length);
        const pageRefs = state.sections.slice(start, end);
        const totalPages = Math.ceil(state.sections.length / state.pageSize);

        sectionInfo.textContent = `Page ${state.currentPage + 1} / ${totalPages}`;
        prevBtn.disabled = state.currentPage === 0;
        nextBtn.disabled = state.currentPage >= totalPages - 1;

        showLoading(`Loading sections ${start + 1}–${end}...`);
        originalText.innerHTML = '';
        translationText.innerHTML = '';

        saveRecent(state.currentWork, start);
        renderRecent();

        try {
            const origPromises = pageRefs.map(urn => fetchPassageText(urn));
            const origResults = await Promise.all(origPromises);

            let engResults = [];
            if (state.currentWork.engUrn) {
                const engRefs = pageRefs.map(urn => {
                    const passageRef = extractPassageRef(urn);
                    return state.currentWork.engUrn + ':' + passageRef;
                });
                engResults = await Promise.all(engRefs.map(u => fetchPassageText(u).catch(() => null)));
            }

            for (let i = 0; i < pageRefs.length; i++) {
                const sectionRef = extractPassageRef(pageRefs[i]);
                const origContent = stripXmlTags(origResults[i] || '');
                const engContent = stripXmlTags(engResults[i] || '');

                const origBlock = document.createElement('div');
                origBlock.className = 'section-block';
                origBlock.innerHTML = `<div class="section-label">§ ${esc(sectionRef)}</div>`;
                const origDiv = document.createElement('div');
                const langType = (state.currentWork.lang === 'lat' || state.currentWork.lang === 'la') ? 'latin' : 'greek';
                origDiv.innerHTML = wrapWords(origContent, langType);
                origBlock.appendChild(origDiv);
                originalText.appendChild(origBlock);

                const engBlock = document.createElement('div');
                engBlock.className = 'section-block';
                engBlock.innerHTML = `<div class="section-label">§ ${esc(sectionRef)}</div>`;
                const engDiv = document.createElement('div');
                const cleanEng = (engContent && !engContent.includes('error') && !engContent.includes('Document is empty'))
                    ? engContent : '';
                engDiv.textContent = cleanEng || '(No translation available)';
                engBlock.appendChild(engDiv);
                translationText.appendChild(engBlock);
            }
        } catch (e) {
            console.error('Failed to load page', e);
            originalText.innerHTML = '<p>Failed to load text.</p>';
        }
        hideLoading();
    }

    async function fetchPassageText(urn) {
        const resp = await fetch(`/api/passage?urn=${encodeURIComponent(urn)}`);
        if (!resp.ok) return '';
        const text = await resp.text();
        return text;
    }

    function extractPassageRef(urn) {
        const parts = urn.split(':');
        return parts[parts.length - 1] || '';
    }

    function stripXmlTags(xml) {
        try {
            const doc = parseXml(xml);
            // Find the passage/body content
            let passageEl = null;
            for (const el of doc.getElementsByTagName('*')) {
                if (el.localName === 'passage' || el.localName === 'body') {
                    passageEl = el;
                }
            }
            const root = passageEl || doc.documentElement;
            return extractTextWithSpaces(root);
        } catch {
            const div = document.createElement('div');
            div.innerHTML = xml;
            return div.textContent.trim();
        }
    }

    function extractTextWithSpaces(el) {
        // Walk the DOM tree, adding spaces between block-level elements (l, p, div, ab, seg)
        const blockTags = new Set(['l', 'p', 'div', 'ab', 'seg', 'sp', 'said']);
        let result = '';
        for (const child of el.childNodes) {
            if (child.nodeType === 3) { // text node
                result += child.textContent;
            } else if (child.nodeType === 1) { // element
                const tag = child.localName;
                const childText = extractTextWithSpaces(child);
                if (blockTags.has(tag)) {
                    result += '\n' + childText;
                } else {
                    result += childText;
                }
            }
        }
        return result.trim();
    }

    // --- Word wrapping for hover ---
    function wrapWords(text, lang) {
        // Split by lines first, then words
        return text.split('\n').map(line =>
            line.split(/(\s+)/).map(w => {
                if (/^\s+$/.test(w)) return w;
                const clean = w.replace(/[.,;:·!?''""\u00AB\u00BB\[\](){}\d\u2014\u2013\u2019\u201C\u201D]/g, '').trim();
                if (!clean) return esc(w);
                return `<span class="word" data-word="${esc(clean)}" data-lang="${lang}">${esc(w)}</span>`;
            }).join('')
        ).join('<br>');
    }

    // --- Greek Unicode to Beta Code ---
    const greekToBeta = (() => {
        const map = {
            'α': 'a', 'β': 'b', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'h', 'θ': 'q',
            'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'c', 'ο': 'o', 'π': 'p',
            'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'u', 'φ': 'f', 'χ': 'x', 'ψ': 'y',
            'ω': 'w',
            'Α': 'A', 'Β': 'B', 'Γ': 'G', 'Δ': 'D', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Θ': 'Q',
            'Ι': 'I', 'Κ': 'K', 'Λ': 'L', 'Μ': 'M', 'Ν': 'N', 'Ξ': 'C', 'Ο': 'O', 'Π': 'P',
            'Ρ': 'R', 'Σ': 'S', 'Τ': 'T', 'Υ': 'U', 'Φ': 'F', 'Χ': 'X', 'Ψ': 'Y', 'Ω': 'W'
        };
        return function(word) {
            // Normalize and strip diacritics (accents, breathing marks)
            const normalized = word.normalize('NFD');
            let result = '';
            for (const ch of normalized) {
                // Skip combining diacritical marks (U+0300-U+036F)
                if (ch.charCodeAt(0) >= 0x0300 && ch.charCodeAt(0) <= 0x036F) continue;
                result += map[ch] || ch;
            }
            return result;
        };
    })();

    // --- Morphology + Definition tooltip ---
    async function showMorphTooltip(wordEl, x, y) {
        const word = wordEl.dataset.word;
        const lang = wordEl.dataset.lang || 'greek';
        if (!word) return;

        tooltip.innerHTML = `<div class="loading-morph">Looking up "${esc(word)}"...</div>`;
        positionTooltip(x, y);
        tooltip.classList.add('visible');

        const cacheKey = lang + ':' + word;
        if (state.morphCache[cacheKey]) {
            renderMorphTooltip(state.morphCache[cacheKey], word);
            return;
        }

        try {
            const lookupWord = (lang === 'greek') ? greekToBeta(word) : word;

            // Step 1: Fetch morphology
            const morphResp = await fetch(`/api/morph?word=${encodeURIComponent(lookupWord)}&lang=${encodeURIComponent(lang)}`);
            const morphText = await morphResp.text();
            const doc = parseXml(morphText);
            const analyses = [];
            let currentAnalysis = null;
            for (const el of doc.getElementsByTagName('*')) {
                if (el.localName === 'analysis') {
                    currentAnalysis = {};
                    analyses.push(currentAnalysis);
                } else if (currentAnalysis) {
                    const name = el.localName;
                    if (['form', 'lemma', 'expandedForm', 'pos', 'number', 'gender',
                         'case', 'tense', 'mood', 'voice', 'person', 'dialect'].includes(name)) {
                        currentAnalysis[name] = el.textContent.trim();
                    }
                }
            }

            // Step 2: Collect unique lemmas and fetch definitions for each
            const uniqueLemmas = [...new Set(analyses.map(a => a.lemma).filter(Boolean))];
            const defMap = {};

            if (uniqueLemmas.length > 0) {
                const defPromises = uniqueLemmas.map(async lemma => {
                    const betaLemma = (lang === 'greek') ? greekToBeta(lemma) : lemma;
                    try {
                        const resp = await fetch(`/api/define?word=${encodeURIComponent(betaLemma)}&lang=${encodeURIComponent(lang)}`);
                        const html = await resp.text();
                        const defs = parseDefinitions(html);
                        if (defs.length > 0) {
                            defMap[lemma] = defs[0].shortDef;
                        }
                    } catch { /* ignore */ }
                });
                await Promise.all(defPromises);
            }

            // Attach definitions to analyses
            for (const a of analyses) {
                if (a.lemma && defMap[a.lemma]) {
                    a.definition = defMap[a.lemma];
                }
            }

            state.morphCache[cacheKey] = analyses;
            renderMorphTooltip(analyses, word);
        } catch {
            tooltip.innerHTML = `<div class="lemma">${esc(word)}</div><div class="definition">Dictionary unavailable</div>`;
        }
    }

    function parseDefinitions(html) {
        // Parse the resolveform HTML to extract lemma + short definition pairs
        // The table has rows with: <td>lemma</td> <td>dict links</td> <td>freq</td> <td>freq</td> <td>short def</td>
        const definitions = [];
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const rows = doc.querySelectorAll('tr');
            for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 4) {
                    // The last <td> in each data row contains the short definition
                    const lastCell = cells[cells.length - 1];
                    const shortDef = lastCell.textContent.trim();
                    // First cell has the lemma link
                    const lemmaLink = cells[0].querySelector('a');
                    const lemma = lemmaLink ? lemmaLink.textContent.trim() : cells[0].textContent.trim();
                    if (shortDef && lemma && !shortDef.match(/^\d/) && shortDef !== 'Min. Freq.') {
                        definitions.push({ lemma, shortDef });
                    }
                }
            }
        } catch { /* ignore parsing errors */ }
        return definitions;
    }

    function renderMorphTooltip(analyses, word) {
        if (!analyses || analyses.length === 0) {
            tooltip.innerHTML = `<div class="lemma">${esc(word)}</div><div class="definition">No entry found</div>`;
            return;
        }
        const seen = new Set();
        const unique = analyses.filter(a => {
            const key = (a.lemma || '') + (a.pos || '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        tooltip.innerHTML = unique.slice(0, 3).map(a => {
            const morphParts = [a.pos, a.number, a.gender, a.case, a.tense, a.mood, a.voice, a.person]
                .filter(Boolean);
            let html = `<div class="lemma">${esc(a.lemma || word)}</div>
                    <div class="morph">${esc(morphParts.join(', '))}</div>`;
            if (a.definition) {
                html += `<div class="definition">${esc(a.definition)}</div>`;
            }
            return html;
        }).join('<hr style="border:none;border-top:1px solid #555;margin:6px 0">');
    }

    function positionTooltip(x, y) {
        let left = x + 10;
        let top = y + 10;
        if (left + 350 > window.innerWidth) left = x - 360;
        if (top + 200 > window.innerHeight) top = y - 200;
        tooltip.style.left = Math.max(0, left) + 'px';
        tooltip.style.top = Math.max(0, top) + 'px';
    }

    // --- Synchronized scrolling ---
    const origPane = $('originalPane');
    const transPane = $('translationPane');
    let syncingScroll = false;

    origPane.addEventListener('scroll', () => {
        if (syncingScroll) return;
        syncingScroll = true;
        const ratio = origPane.scrollTop / (origPane.scrollHeight - origPane.clientHeight || 1);
        transPane.scrollTop = ratio * (transPane.scrollHeight - transPane.clientHeight);
        syncingScroll = false;
    });
    transPane.addEventListener('scroll', () => {
        if (syncingScroll) return;
        syncingScroll = true;
        const ratio = transPane.scrollTop / (transPane.scrollHeight - transPane.clientHeight || 1);
        origPane.scrollTop = ratio * (origPane.scrollHeight - origPane.clientHeight);
        syncingScroll = false;
    });

    // --- Events ---
    let searchTimeout;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => search(searchInput.value.trim()), 200);
    });
    searchInput.addEventListener('focus', () => {
        if (searchInput.value.trim().length >= 2) searchResults.classList.add('visible');
    });
    document.addEventListener('click', e => {
        if (!searchResults.contains(e.target) && e.target !== searchInput)
            searchResults.classList.remove('visible');
    });

    searchResults.addEventListener('click', e => {
        const item = e.target.closest('.search-result-item');
        if (!item) return;
        const urn = item.dataset.urn;
        if (urn) { searchResults.classList.remove('visible'); searchInput.value = ''; openWork(urn, 0); }
    });

    recentList.addEventListener('click', e => {
        const item = e.target.closest('.recent-item');
        if (!item) return;
        const urn = item.dataset.urn;
        const section = parseInt(item.dataset.section) || 0;
        if (urn) {
            const recent = getRecent().find(r => r.urn === urn);
            if (recent && !state.works.find(w => w.urn === urn)) state.works.push(recent);
            openWork(urn, section);
        }
    });

    backBtn.addEventListener('click', () => showPage(landing));
    prevBtn.addEventListener('click', () => { if (state.currentPage > 0) { state.currentPage--; loadCurrentPage(); } });
    nextBtn.addEventListener('click', () => {
        if (state.currentPage < Math.ceil(state.sections.length / state.pageSize) - 1) {
            state.currentPage++;
            loadCurrentPage();
        }
    });

    let tooltipTimeout;
    document.addEventListener('mouseover', e => {
        const wordEl = e.target.closest('.word');
        if (wordEl) {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = setTimeout(() => showMorphTooltip(wordEl, e.clientX, e.clientY), 300);
        }
    });
    document.addEventListener('mouseout', e => {
        if (e.target.closest('.word')) { clearTimeout(tooltipTimeout); tooltip.classList.remove('visible'); }
    });
    document.addEventListener('mousemove', e => {
        if (tooltip.classList.contains('visible')) positionTooltip(e.clientX, e.clientY);
    });

    // --- Fallback popular works ---
    function loadPopularWorks() {
        state.works = [
            { urn: 'urn:cts:greekLit:tlg0012.tlg001', label: 'Iliad', author: 'Homer', lang: 'grc',
              origUrn: 'urn:cts:greekLit:tlg0012.tlg001.perseus-grc2', engUrn: 'urn:cts:greekLit:tlg0012.tlg001.perseus-eng3' },
            { urn: 'urn:cts:greekLit:tlg0012.tlg002', label: 'Odyssey', author: 'Homer', lang: 'grc',
              origUrn: 'urn:cts:greekLit:tlg0012.tlg002.perseus-grc2', engUrn: 'urn:cts:greekLit:tlg0012.tlg002.perseus-eng3' },
            { urn: 'urn:cts:greekLit:tlg0059.tlg030', label: 'Republic', author: 'Plato', lang: 'grc',
              origUrn: 'urn:cts:greekLit:tlg0059.tlg030.perseus-grc2', engUrn: 'urn:cts:greekLit:tlg0059.tlg030.perseus-eng2' },
            { urn: 'urn:cts:greekLit:tlg0085.tlg003', label: 'Antigone', author: 'Sophocles', lang: 'grc',
              origUrn: 'urn:cts:greekLit:tlg0085.tlg003.perseus-grc2', engUrn: 'urn:cts:greekLit:tlg0085.tlg003.perseus-eng1' },
            { urn: 'urn:cts:greekLit:tlg0003.tlg001', label: 'History of the Peloponnesian War', author: 'Thucydides', lang: 'grc',
              origUrn: 'urn:cts:greekLit:tlg0003.tlg001.perseus-grc2', engUrn: 'urn:cts:greekLit:tlg0003.tlg001.perseus-eng6' },
            { urn: 'urn:cts:latinLit:phi0448.phi001', label: 'De Bello Gallico', author: 'Caesar', lang: 'lat',
              origUrn: 'urn:cts:latinLit:phi0448.phi001.perseus-lat1', engUrn: 'urn:cts:latinLit:phi0448.phi001.perseus-eng1' },
            { urn: 'urn:cts:latinLit:phi0690.phi003', label: 'Aeneid', author: 'Virgil', lang: 'lat',
              origUrn: 'urn:cts:latinLit:phi0690.phi003.perseus-lat2', engUrn: 'urn:cts:latinLit:phi0690.phi003.perseus-eng2' },
        ];
    }

    // --- Theme Picker ---
    const themeBtn = $('themeBtnLanding');
    const themePicker = $('themePicker');

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('greekReaderTheme', theme);
        // Highlight active swatch
        document.querySelectorAll('.theme-swatch').forEach(s => {
            s.classList.toggle('active', s.dataset.theme === theme);
        });
    }

    themeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        themePicker.classList.toggle('visible');
    });

    themePicker.addEventListener('click', (e) => {
        const swatch = e.target.closest('.theme-swatch');
        if (swatch) {
            setTheme(swatch.dataset.theme);
            themePicker.classList.remove('visible');
        }
        e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
        if (!themePicker.contains(e.target) && e.target !== themeBtn) {
            themePicker.classList.remove('visible');
        }
    });

    // Restore saved theme
    const savedTheme = localStorage.getItem('greekReaderTheme') || 'parchment';
    setTheme(savedTheme);

    // --- AI Analysis (Gemini) ---
    const selectionPopup = $('selectionPopup');
    const analyzeBtn = $('analyzeBtn');
    const analysisPanel = $('analysisPanel');
    const analysisContent = $('analysisContent');
    const closeAnalysis = $('closeAnalysis');
    const apiKeyModal = $('apiKeyModal');
    const apiKeyInput = $('apiKeyInput');
    const apiKeySave = $('apiKeySave');
    const apiKeyCancel = $('apiKeyCancel');

    let selectedText = '';

    function getApiKey() {
        return localStorage.getItem('geminiApiKey') || 'AIzaSyCG8NGG2kcrLdviB5EIfNjnSZW3SgZ1QHc';
    }

    // Show "Analyze" button near selection
    document.addEventListener('mouseup', (e) => {
        // Only in reader pane
        if (!e.target.closest('#originalPane')) {
            selectionPopup.classList.remove('visible');
            return;
        }
        const sel = window.getSelection();
        const text = sel.toString().trim();
        if (text.length < 2) {
            selectionPopup.classList.remove('visible');
            return;
        }
        selectedText = text;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        selectionPopup.style.left = (rect.left + rect.width / 2 - 60) + 'px';
        selectionPopup.style.top = (rect.top - 40) + 'px';
        selectionPopup.classList.add('visible');
    });

    document.addEventListener('mousedown', (e) => {
        if (!selectionPopup.contains(e.target)) {
            selectionPopup.classList.remove('visible');
        }
    });

    analyzeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectionPopup.classList.remove('visible');
        if (!getApiKey()) {
            apiKeyModal.classList.add('visible');
            apiKeyInput.focus();
            return;
        }
        runAnalysis(selectedText);
    });

    // API key modal
    apiKeySave.addEventListener('click', () => {
        const key = apiKeyInput.value.trim();
        if (key) {
            localStorage.setItem('geminiApiKey', key);
            apiKeyModal.classList.remove('visible');
            apiKeyInput.value = '';
            runAnalysis(selectedText);
        }
    });

    apiKeyCancel.addEventListener('click', () => {
        apiKeyModal.classList.remove('visible');
        apiKeyInput.value = '';
    });

    apiKeyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') apiKeySave.click();
        if (e.key === 'Escape') apiKeyCancel.click();
    });

    closeAnalysis.addEventListener('click', () => {
        analysisPanel.classList.remove('visible');
    });

    async function runAnalysis(text) {
        analysisPanel.classList.add('visible');
        analysisContent.innerHTML = `
            <div class="ai-source-text">${esc(text)}</div>
            <div class="ai-loading"><div class="mini-spinner"></div> Analyzing with Gemini...</div>
        `;

        const apiKey = getApiKey();
        const lang = (state.currentWork && (state.currentWork.lang === 'lat' || state.currentWork.lang === 'la'))
            ? 'Latin' : 'Ancient Greek';

        const prompt = `You are an expert classicist and ${lang} scholar. Analyze the following ${lang} text.

Provide:
1. **Literal Translation**: A word-for-word literal translation preserving the original word order as much as possible.
2. **Smooth Translation**: A natural, readable English translation.
3. **Word-by-Word Analysis**: For each word, provide a table with columns: Word | Lemma | Part of Speech | Morphology | Meaning

Format your response in clean HTML (no markdown). Use <h4> for headings, <table> for the word analysis, and <p> for translations. Do not include <html>, <body>, or <head> tags.

Text to analyze:
${text}`;

        try {
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }]
                    })
                }
            );

            if (!resp.ok) {
                const err = await resp.json();
                const msg = err.error?.message || 'API request failed';
                if (resp.status === 400 || resp.status === 403) {
                    localStorage.removeItem('geminiApiKey');
                    analysisContent.innerHTML = `
                        <div class="ai-source-text">${esc(text)}</div>
                        <div class="ai-error">Invalid API key. Please try again.</div>
                    `;
                    return;
                }
                throw new Error(msg);
            }

            const data = await resp.json();
            const result = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';

            // Strip markdown code fences if present
            let html = result.replace(/```html\n?/g, '').replace(/```\n?/g, '');

            analysisContent.innerHTML = `
                <div class="ai-source-text">${esc(text)}</div>
                <div class="ai-result">${html}</div>
            `;
        } catch (e) {
            analysisContent.innerHTML = `
                <div class="ai-source-text">${esc(text)}</div>
                <div class="ai-error">Error: ${esc(e.message)}</div>
            `;
        }
    }

    // --- Init ---
    async function init() {
        renderRecent();
        await fetchCapabilities();
        console.log(`Loaded ${state.works.length} works`);
        renderRecent();
    }

    init();
})();
