// Stoa Reader — wired to the live Perseus-backed API.
//
// Replaces the prototype's hardcoded window.PASSAGES with live fetches:
//   /api/library                 → list authors / works / editions
//   /api/reff?urn=<work-urn>     → table of contents (sections) for a work
//   /api/passage?urn=<urn>       → plain text for one section (Greek or English)
//   /api/morph?word=&lang=       → Morpheus JSON for a single word
//   /api/define?word=&lang=      → Tufts hopper HTML for a lemma definition
//
// Per-token lemma/POS/gloss aren't in the passage payload, so tokens render
// bare and the Lexicon panel populates lazily on click. Cross-highlight and
// inline footnote markers are inert (no alignment data from the API).

const { useState, useEffect, useRef, useMemo, useCallback } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "layout": "parallel",
  "theme": "light"
}/*EDITMODE-END*/;

const PUNCT_RE = /[.,;:·!?'"«»ʼ᾽᾿῾\[\](){}\d—–‘’“”]/g;

function cleanWord(w) {
  return w.replace(PUNCT_RE, '').trim();
}

function stripDiacritics(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Perseus' /text/ endpoint returns each section as a single paragraph, so we
// fall back to splitting on sentence-end punctuation to get display lines.
function splitIntoSentences(text) {
  if (!text) return [];
  const out = [];
  // Split on Greek high stop · or . or ; (Greek question mark) keeping the
  // delimiter glued to the preceding sentence.
  const re = /[^·.;]+[·.;]?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}

function tokenizePassage(text, prefix) {
  const sentences = splitIntoSentences((text || '').replace(/\s+/g, ' '));
  return sentences.map((line, li) => {
    const parts = line.split(/\s+/).filter(p => p.length);
    return {
      n: li + 1,
      raw: line,
      greek: parts.map((w, ti) => ({
        id: `${prefix}-${li + 1}-${ti}`,
        w,
        clean: cleanWord(w)
      }))
    };
  });
}

function splitEnglishLines(text) {
  return splitIntoSentences((text || '').replace(/\s+/g, ' '));
}

function pairLines(greekLines, englishLines) {
  // We don't have alignment from the API, so pair sequentially.
  // If counts differ, distribute English across Greek lines proportionally.
  const out = greekLines.map((gl, i) => {
    const eng = englishLines[i] || '';
    return { ...gl, translation: [{ t: eng, refs: [] }] };
  });
  // If english has extra lines, append the leftovers to the last greek line.
  if (englishLines.length > greekLines.length && out.length) {
    const tail = englishLines.slice(greekLines.length).join(' ');
    const last = out[out.length - 1];
    out[out.length - 1] = {
      ...last,
      translation: [{ t: (last.translation[0]?.t || '') + ' ' + tail, refs: [] }]
    };
  }
  return out;
}

// ── Library helpers ──────────────────────────────────────────────────────────

function buildLibrary(data) {
  const textsByUrn = {};
  for (const t of (data.texts || [])) textsByUrn[t.urn] = t;
  const worksByUrn = {};
  for (const w of (data.works || [])) worksByUrn[w.urn] = w;

  const works = [];
  for (const tg of (data.text_groups || [])) {
    const author = tg.label || tg.urn;
    for (const work of (tg.works || [])) {
      const meta = worksByUrn[work.urn] || {};
      const title = meta.label || work.label || work.urn;
      let origUrn = '', engUrn = '', origLang = '', origTitle = '';
      for (const text of (work.texts || [])) {
        const tmeta = textsByUrn[text.urn] || {};
        if (tmeta.kind === 'edition' && !origUrn) {
          origUrn = text.urn;
          origLang = tmeta.lang || '';
          origTitle = tmeta.label || '';
        } else if (tmeta.kind === 'translation' && tmeta.lang === 'eng' && !engUrn) {
          engUrn = text.urn;
        }
      }
      if (origUrn) {
        works.push({
          workUrn: work.urn,
          author,                  // original-language author name when available
          authorEn: author,        // we don't have a separate english author label
          work: origTitle || title,
          workEn: title,
          origUrn,
          engUrn,
          lang: origLang || 'grc'
        });
      }
    }
  }
  return works;
}

// ── Top-level App ────────────────────────────────────────────────────────────

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Library: list of all works pulled from /api/library
  const [library, setLibrary] = useState([]);
  const [libraryError, setLibraryError] = useState(null);

  // Currently-selected work (from the library) and its TOC
  const [currentWork, setCurrentWork] = useState(null);
  const [toc, setToc] = useState([]);                 // [{ urn, label, num }]
  const [sectionIdx, setSectionIdx] = useState(0);

  // The loaded passage (synthesized into the same shape the design used)
  const [passage, setPassage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');

  // Reader interactions
  const [selectedTok, setSelectedTok] = useState(null);
  const [hoverIds, setHoverIds] = useState(new Set());
  const [showInterlinearGloss, setShowInterlinearGloss] = useState(true);

  // Bookmarks (new schema: urn-based)
  const [bookmarks, setBookmarks] = useState(() => {
    try { return JSON.parse(localStorage.getItem('stoa-bookmarks') || '[]'); }
    catch { return []; }
  });
  const [bookmarkDialog, setBookmarkDialog] = useState(null); // { line }

  // Pin / collapse state — preserved from the prototype
  const [topPinned, setTopPinned] = useState(() => {
    const v = localStorage.getItem('stoa-top-pinned');
    return v === null ? true : v === '1';
  });
  const [sidePinned, setSidePinned] = useState(() => {
    const v = localStorage.getItem('stoa-side-pinned');
    return v === null ? true : v === '1';
  });
  const [topRevealed, setTopRevealed] = useState(false);
  const [sideRevealed, setSideRevealed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const readerRef = useRef(null);
  const topHideTimer = useRef(null);
  const sideHideTimer = useRef(null);

  useEffect(() => { localStorage.setItem('stoa-top-pinned', topPinned ? '1' : '0'); }, [topPinned]);
  useEffect(() => { localStorage.setItem('stoa-side-pinned', sidePinned ? '1' : '0'); }, [sidePinned]);
  useEffect(() => { localStorage.setItem('stoa-bookmarks', JSON.stringify(bookmarks)); }, [bookmarks]);
  useEffect(() => { document.documentElement.setAttribute('data-theme', tweaks.theme); }, [tweaks.theme]);

  // ── Initial library fetch ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/library');
        if (!r.ok) throw new Error('Library fetch failed');
        const data = await r.json();
        if (cancelled) return;
        const works = buildLibrary(data);
        setLibrary(works);
        // Auto-load Iliad if present, else first work — gives the reader something to render.
        const iliad = works.find(w => w.workUrn === 'urn:cts:greekLit:tlg0012.tlg001');
        loadWork(iliad || works[0]);
      } catch (e) {
        console.error(e);
        if (!cancelled) setLibraryError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Work / section loading ──
  async function loadWork(work, startIdx = 0) {
    if (!work) return;
    setCurrentWork(work);
    setLoading(true);
    setLoadingMsg(`Loading sections of ${work.workEn}…`);
    setPassage(null);
    setSelectedTok(null);
    try {
      const r = await fetch(`/api/reff?urn=${encodeURIComponent(work.origUrn)}`);
      if (!r.ok) throw new Error('TOC fetch failed');
      const data = await r.json();
      const entries = (data.toc || []).map(e => ({
        urn: `${work.origUrn}:${e.num || (e.urn || '').split(':').pop()}`,
        engUrn: work.engUrn ? `${work.engUrn}:${e.num || (e.urn || '').split(':').pop()}` : '',
        label: e.label ? `${e.label} ${e.num}` : (e.num || ''),
        num: e.num || ''
      })).filter(e => e.num);
      if (entries.length === 0 && data.first_passage?.urn) {
        const num = (data.first_passage.urn || '').split(':').pop();
        entries.push({
          urn: data.first_passage.urn,
          engUrn: work.engUrn ? `${work.engUrn}:${num}` : '',
          label: num,
          num
        });
      }
      if (entries.length === 0) {
        throw new Error('No sections found for this work.');
      }
      setToc(entries);
      const idx = Math.max(0, Math.min(startIdx, entries.length - 1));
      setSectionIdx(idx);
      await loadSection(work, entries, idx);
    } catch (e) {
      console.error(e);
      setLoading(false);
      setLoadingMsg('');
      alert(e.message || 'Failed to load work.');
    }
  }

  async function loadSection(work, tocEntries, idx) {
    const entry = tocEntries[idx];
    if (!entry) return;
    setLoading(true);
    setLoadingMsg(`Loading ${entry.label}…`);
    try {
      const [origText, engText] = await Promise.all([
        fetch(`/api/passage?urn=${encodeURIComponent(entry.urn)}`).then(r => r.ok ? r.text() : ''),
        entry.engUrn
          ? fetch(`/api/passage?urn=${encodeURIComponent(entry.engUrn)}`).then(r => r.ok ? r.text() : '').catch(() => '')
          : Promise.resolve('')
      ]);
      const greekLines = tokenizePassage(origText, `${work.workUrn}-${entry.num}`);
      const englishLines = splitEnglishLines(engText);
      const lines = pairLines(greekLines, englishLines);
      setPassage({
        id: entry.urn,
        author: work.author,
        authorEn: work.authorEn,
        work: work.work,
        workEn: work.workEn,
        section: entry.label,
        meter: '',
        date: '',
        lang: work.lang,
        lines,
        footnotes: []
      });
    } catch (e) {
      console.error(e);
      alert('Failed to load passage.');
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  function gotoSection(idx) {
    if (!currentWork || !toc.length) return;
    const clamped = Math.max(0, Math.min(idx, toc.length - 1));
    setSectionIdx(clamped);
    setSelectedTok(null);
    loadSection(currentWork, toc, clamped);
  }

  // ── Reader interactions ──
  const tokenMap = useMemo(() => {
    const map = {};
    if (passage) passage.lines.forEach(l => l.greek.forEach(t => { map[t.id] = t; }));
    return map;
  }, [passage]);

  function selectTok(tok) { setSelectedTok(tok); }
  function hoverGreek(tok) { setHoverIds(tok ? new Set([tok.id]) : new Set()); }
  function hoverTrans(refs) { setHoverIds(new Set(refs || [])); }

  function addBookmark(line, note) {
    if (!passage || !currentWork) return;
    const greekText = line.greek.map(t => t.w).join(' ');
    const newBm = {
      id: `${passage.id}-${line.n}-${Date.now()}`,
      passageUrn: passage.id,
      workUrn: currentWork.workUrn,
      passageTitle: currentWork.workEn,
      sectionLabel: passage.section,
      lineNum: line.n,
      greek: greekText,
      note: note || ''
    };
    setBookmarks([newBm, ...bookmarks]);
  }
  function removeBookmark(id) { setBookmarks(bookmarks.filter(b => b.id !== id)); }

  function jumpToBookmark(bm) {
    // Find work + section in current library
    const work = library.find(w => w.workUrn === bm.workUrn);
    if (!work) return;
    if (currentWork && currentWork.workUrn === bm.workUrn && passage?.id === bm.passageUrn) {
      // Same passage already open — just scroll
      setTimeout(() => {
        const el = document.getElementById(`line-${passage.id}-${bm.lineNum}`);
        if (el && readerRef.current) readerRef.current.scrollTo({ top: el.offsetTop - 80, behavior: 'smooth' });
      }, 60);
      return;
    }
    // Need to load that work + the right section
    (async () => {
      setCurrentWork(work);
      setLoading(true);
      setLoadingMsg(`Loading ${work.workEn}…`);
      try {
        const r = await fetch(`/api/reff?urn=${encodeURIComponent(work.origUrn)}`);
        const data = await r.json();
        const entries = (data.toc || []).map(e => ({
          urn: `${work.origUrn}:${e.num || (e.urn || '').split(':').pop()}`,
          engUrn: work.engUrn ? `${work.engUrn}:${e.num || (e.urn || '').split(':').pop()}` : '',
          label: e.label ? `${e.label} ${e.num}` : (e.num || ''),
          num: e.num || ''
        })).filter(e => e.num);
        setToc(entries);
        const idx = entries.findIndex(e => e.urn === bm.passageUrn);
        const finalIdx = idx >= 0 ? idx : 0;
        setSectionIdx(finalIdx);
        await loadSection(work, entries, finalIdx);
        setTimeout(() => {
          const el = document.getElementById(`line-${bm.passageUrn}-${bm.lineNum}`);
          if (el && readerRef.current) readerRef.current.scrollTo({ top: el.offsetTop - 80, behavior: 'smooth' });
        }, 80);
      } catch (e) { console.error(e); }
      finally { setLoading(false); setLoadingMsg(''); }
    })();
  }

  function jumpToSearch(workUrn, sectionNum) {
    setSearchOpen(false);
    const work = library.find(w => w.workUrn === workUrn);
    if (!work) return;
    if (currentWork && currentWork.workUrn === workUrn && toc.length) {
      const idx = toc.findIndex(e => e.num === sectionNum);
      if (idx >= 0) gotoSection(idx);
      return;
    }
    (async () => {
      // Resolve TOC then jump to the requested section
      try {
        const r = await fetch(`/api/reff?urn=${encodeURIComponent(work.origUrn)}`);
        const data = await r.json();
        const entries = (data.toc || []).map(e => ({
          urn: `${work.origUrn}:${e.num || (e.urn || '').split(':').pop()}`,
          engUrn: work.engUrn ? `${work.engUrn}:${e.num || (e.urn || '').split(':').pop()}` : '',
          label: e.label ? `${e.label} ${e.num}` : (e.num || ''),
          num: e.num || ''
        })).filter(e => e.num);
        const idx = sectionNum ? entries.findIndex(e => e.num === sectionNum) : 0;
        const finalIdx = idx >= 0 ? idx : 0;
        setCurrentWork(work);
        setToc(entries);
        setSectionIdx(finalIdx);
        await loadSection(work, entries, finalIdx);
      } catch (e) { console.error(e); }
    })();
  }

  // ⌘K / Ctrl+K to open search
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(s => !s);
      } else if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchOpen]);

  return (
    <div className={`app ${topPinned && sidePinned ? 'both-pinned' : topPinned ? 'top-pinned-only' : sidePinned ? 'side-pinned-only' : 'none-pinned'} ${topRevealed ? 'revealing-top' : ''} ${sideRevealed ? 'revealing-side' : ''}`}>
      {!topPinned && (
        <>
          <div className="hover-trigger-top" onMouseEnter={() => { clearTimeout(topHideTimer.current); setTopRevealed(true); }} />
          <div className="edge-chip top">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 6l4 4 4-4"/></svg>
            Menu
          </div>
        </>
      )}
      {!sidePinned && (
        <>
          <div className="hover-trigger-side" onMouseEnter={() => { clearTimeout(sideHideTimer.current); setSideRevealed(true); }} />
          <div className="edge-chip side">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 4l4 4-4 4"/></svg>
            Library
          </div>
        </>
      )}
      <div
        style={{ display: 'contents' }}
        onMouseLeave={() => { if (!topPinned) topHideTimer.current = setTimeout(() => setTopRevealed(false), 200); }}
        onMouseEnter={() => { if (!topPinned) clearTimeout(topHideTimer.current); }}
      >
        <Topbar
          currentWork={currentWork}
          passage={passage}
          toc={toc}
          sectionIdx={sectionIdx}
          onPrev={() => gotoSection(sectionIdx - 1)}
          onNext={() => gotoSection(sectionIdx + 1)}
          onPickSection={gotoSection}
          tweaks={tweaks}
          setTweak={setTweak}
          showInterlinearGloss={showInterlinearGloss}
          setShowInterlinearGloss={setShowInterlinearGloss}
          pinned={topPinned}
          onTogglePin={() => { setTopPinned(!topPinned); setTopRevealed(false); }}
          revealed={topRevealed}
          onOpenSearch={() => setSearchOpen(true)}
        />
      </div>
      <div
        style={{ display: 'contents' }}
        onMouseLeave={() => { if (!sidePinned) sideHideTimer.current = setTimeout(() => setSideRevealed(false), 200); }}
        onMouseEnter={() => { if (!sidePinned) clearTimeout(sideHideTimer.current); }}
      >
        <Sidebar
          currentWork={currentWork}
          toc={toc}
          sectionIdx={sectionIdx}
          onPickSection={gotoSection}
          bookmarks={bookmarks}
          onJumpBookmark={jumpToBookmark}
          onRemoveBookmark={removeBookmark}
          onOpenSearch={() => setSearchOpen(true)}
          pinned={sidePinned}
          onTogglePin={() => { setSidePinned(!sidePinned); setSideRevealed(false); }}
          revealed={sideRevealed}
        />
      </div>
      <main className="reader" ref={readerRef}>
        <div className="reader-inner">
          {loading && (
            <div style={{ padding: '32px 0', color: 'var(--ink-3)', fontStyle: 'italic' }}>{loadingMsg || 'Loading…'}</div>
          )}
          {!loading && libraryError && (
            <div style={{ padding: '32px 0', color: 'var(--ink-2)' }}>
              Library unavailable: {libraryError}
            </div>
          )}
          {!loading && passage && (
            <>
              <WorkHead passage={passage} />
              <Lines
                passage={passage}
                layout={tweaks.layout}
                selectedTok={selectedTok}
                hoverIds={hoverIds}
                onSelectTok={selectTok}
                onHoverGreek={hoverGreek}
                onHoverTrans={hoverTrans}
                onBookmark={(line) => setBookmarkDialog({ line })}
                showInterlinearGloss={showInterlinearGloss}
              />
            </>
          )}
        </div>
      </main>
      <Lexicon
        tok={selectedTok}
        lang={passage?.lang}
        onClose={() => setSelectedTok(null)}
        onAddBookmark={() => {
          if (!selectedTok || !passage) return;
          const line = passage.lines.find(l => l.greek.some(t => t.id === selectedTok.id));
          if (line) setBookmarkDialog({ line, prefilledNote: selectedTok.clean });
        }}
      />
      {bookmarkDialog && passage && (
        <BookmarkDialog
          line={bookmarkDialog.line}
          passage={passage}
          prefilledNote={bookmarkDialog.prefilledNote}
          onSave={(note) => { addBookmark(bookmarkDialog.line, note); setBookmarkDialog(null); }}
          onCancel={() => setBookmarkDialog(null)}
        />
      )}
      {searchOpen && (
        <LibrarySearchOverlay
          library={library}
          currentWork={currentWork}
          toc={toc}
          onClose={() => setSearchOpen(false)}
          onPickWork={(w) => { setSearchOpen(false); loadWork(w, 0); }}
          onJump={jumpToSearch}
        />
      )}
    </div>
  );
}

// ── Topbar ───────────────────────────────────────────────────────────────────

function Topbar({ currentWork, passage, toc, sectionIdx, onPrev, onNext, onPickSection,
                  tweaks, setTweak, showInterlinearGloss, setShowInterlinearGloss,
                  pinned, onTogglePin, revealed, onOpenSearch }) {
  const themes = ['light', 'sepia', 'dark'];
  const layouts = [
    { id: 'parallel', label: 'Parallel' },
    { id: 'stacked', label: 'Stacked' },
    { id: 'interlinear', label: 'Interlinear' }
  ];
  const cycleTheme = () => {
    const i = themes.indexOf(tweaks.theme);
    setTweak('theme', themes[(i + 1) % themes.length]);
  };
  return (
    <header className={`topbar ${revealed ? 'revealed' : ''}`}>
      <div className="brand">
        <span className="glyph">Ω</span>
        <span className="name">Stoa</span>
        <span className="tag">Reader</span>
      </div>
      <div className="tabs" role="tablist">
        {currentWork ? (
          <button className="tab active" onClick={onOpenSearch} title="Browse library">
            <span style={{ fontFamily: "'GFS Neohellenic', serif" }}>{currentWork.work}</span>
            <span className="work-en">{currentWork.authorEn}</span>
          </button>
        ) : (
          <button className="tab active" onClick={onOpenSearch}>
            <span>Browse library…</span>
          </button>
        )}
        {toc.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12 }}>
            <button className="icon-btn" onClick={onPrev} disabled={sectionIdx <= 0} title="Previous section">‹</button>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--ink-3)', minWidth: 70, textAlign: 'center' }}>
              {sectionIdx + 1} / {toc.length}
            </span>
            <button className="icon-btn" onClick={onNext} disabled={sectionIdx >= toc.length - 1} title="Next section">›</button>
          </div>
        )}
      </div>
      <div className="spacer" />
      <div className="tools">
        <button className="search-trigger" onClick={onOpenSearch} title="Search (⌘K)">
          <Icon name="search" />
          <span>Search</span>
          <kbd>⌘K</kbd>
        </button>
        <div style={{ display: 'flex', gap: 2, marginRight: 8 }}>
          {layouts.map(l => (
            <button
              key={l.id}
              className={`tab ${tweaks.layout === l.id ? 'active' : ''}`}
              onClick={() => setTweak('layout', l.id)}
              style={{ fontSize: 12 }}
              title={`${l.label} layout`}
            >
              {l.label}
            </button>
          ))}
        </div>
        {tweaks.layout === 'interlinear' && (
          <button
            className={`icon-btn ${showInterlinearGloss ? 'on' : ''}`}
            onClick={() => setShowInterlinearGloss(!showInterlinearGloss)}
            title="Toggle gloss"
          >
            <Icon name="gloss" />
          </button>
        )}
        <button className="icon-btn" onClick={cycleTheme} title={`Theme: ${tweaks.theme}`}>
          <Icon name={tweaks.theme === 'dark' ? 'moon' : tweaks.theme === 'sepia' ? 'sun-warm' : 'sun'} />
        </button>
        <button
          className={`icon-btn pin-btn ${pinned ? 'pinned' : ''}`}
          onClick={onTogglePin}
          title={pinned ? 'Unpin top bar' : 'Pin top bar'}
        >
          <Icon name={pinned ? 'pin-on' : 'pin-off'} />
        </button>
      </div>
    </header>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar({ currentWork, toc, sectionIdx, onPickSection,
                   bookmarks, onJumpBookmark, onRemoveBookmark,
                   onOpenSearch,
                   pinned, onTogglePin, revealed }) {
  return (
    <aside className={`sidebar ${revealed ? 'revealed' : ''}`}>
      <button
        className={`icon-btn pin-btn sidebar-pin ${pinned ? 'pinned' : ''}`}
        onClick={onTogglePin}
        title={pinned ? 'Unpin sidebar' : 'Pin sidebar'}
      >
        <Icon name={pinned ? 'pin-on' : 'pin-off'} />
      </button>
      <div className="side-section">
        <div className="side-h">Library</div>
        <button className="side-item" onClick={onOpenSearch} style={{ cursor: 'pointer' }}>
          <div>Browse all works…</div>
          <div className="author">⌘K</div>
        </button>
        {currentWork && (
          <button className="side-item active" onClick={onOpenSearch}>
            <div>{currentWork.workEn}</div>
            <div className="author">{currentWork.authorEn}</div>
          </button>
        )}
      </div>
      {toc.length > 0 && (
        <div className="side-section">
          <div className="side-h">Sections</div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {toc.map((entry, i) => (
              <button
                key={entry.urn}
                className={`side-item ${i === sectionIdx ? 'active' : ''}`}
                onClick={() => onPickSection(i)}
                style={{ paddingTop: 6, paddingBottom: 6 }}
              >
                <div style={{ fontSize: 13 }}>{entry.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="side-section">
        <div className="side-h">Bookmarks</div>
        {bookmarks.length === 0 && (
          <div className="bookmark-empty">No bookmarks yet. Click a word and press “Bookmark” to save a passage.</div>
        )}
        {bookmarks.map(bm => (
          <div key={bm.id} className="bookmark-row" onClick={() => onJumpBookmark(bm)}>
            <div className="bm-mark" />
            <div className="bm-info">
              <div className="bm-line">{bm.passageTitle} · {bm.sectionLabel} · l. {bm.lineNum}</div>
              <div className="bm-text">{bm.greek}</div>
              {bm.note && (
                <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic', marginTop: 4, lineHeight: 1.4 }}>
                  {bm.note}
                </div>
              )}
            </div>
            <button
              className="icon-btn"
              style={{ width: 24, height: 24, flexShrink: 0 }}
              onClick={(e) => { e.stopPropagation(); onRemoveBookmark(bm.id); }}
              title="Remove"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ── Reader sub-components ────────────────────────────────────────────────────

function WorkHead({ passage }) {
  return (
    <div className="work-head">
      <div className="titles">
        <div className="author-line">
          <span className="author-grk">{passage.author}</span>
          <span className="author-en">{passage.authorEn}</span>
        </div>
        <div className="work-grk">{passage.work}</div>
        <div className="work-en">{passage.workEn}</div>
      </div>
      <div className="meta">
        <div className="section">{passage.section}</div>
      </div>
    </div>
  );
}

function Lines({ passage, layout, selectedTok, hoverIds, onSelectTok,
                 onHoverGreek, onHoverTrans, showInterlinearGloss }) {
  if (!passage) return null;
  if (layout === 'interlinear') {
    return (
      <div className="lines interlinear">
        {passage.lines.map(line => (
          <div key={line.n} className="line" id={`line-${passage.id}-${line.n}`}>
            <div className="il-line-num">{line.n}</div>
            <div className="il-row">
              {line.greek.map(tok => (
                <div
                  key={tok.id}
                  className={`il-pair ${selectedTok?.id === tok.id ? 'selected' : ''}`}
                  onClick={() => onSelectTok(tok)}
                >
                  <span className="il-grk">{tok.w}</span>
                  {showInterlinearGloss && <>
                    <span className="il-pos">{tok.pos || ''}</span>
                    <span className="il-gloss">{tok.gloss || ''}</span>
                  </>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`lines ${layout === 'stacked' ? 'stacked' : ''}`}>
      {passage.lines.map(line => (
        <div key={line.n} className="line" id={`line-${passage.id}-${line.n}`}>
          <div className="line-num">{line.n}</div>
          <div className="greek-col">
            {line.greek.map((tok, i) => (
              <React.Fragment key={tok.id}>
                <span
                  className={`tok ${selectedTok?.id === tok.id ? 'selected' : ''} ${hoverIds.has(tok.id) ? 'linked-hover' : ''}`}
                  onClick={() => onSelectTok(tok)}
                  onMouseEnter={() => onHoverGreek(tok)}
                  onMouseLeave={() => onHoverGreek(null)}
                >
                  {tok.w}
                </span>
                {i < line.greek.length - 1 && ' '}
              </React.Fragment>
            ))}
          </div>
          <div className="trans-col">
            {line.translation.map((seg, i) => (
              <React.Fragment key={i}>
                <span
                  className={`tok ${seg.refs.some(r => hoverIds.has(r)) ? 'linked-hover' : ''}`}
                  onMouseEnter={() => onHoverTrans(seg.refs)}
                  onMouseLeave={() => onHoverTrans([])}
                >
                  {seg.t || (i === 0 ? '' : '')}
                </span>
                {i < line.translation.length - 1 && ' '}
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Lexicon (live morphology lookup on token select) ─────────────────────────

const greekToBeta = (() => {
  const map = {
    'α':'a','β':'b','γ':'g','δ':'d','ε':'e','ζ':'z','η':'h','θ':'q',
    'ι':'i','κ':'k','λ':'l','μ':'m','ν':'n','ξ':'c','ο':'o','π':'p',
    'ρ':'r','σ':'s','ς':'s','τ':'t','υ':'u','φ':'f','χ':'x','ψ':'y','ω':'w',
    'Α':'A','Β':'B','Γ':'G','Δ':'D','Ε':'E','Ζ':'Z','Η':'H','Θ':'Q',
    'Ι':'I','Κ':'K','Λ':'L','Μ':'M','Ν':'N','Ξ':'C','Ο':'O','Π':'P',
    'Ρ':'R','Σ':'S','Τ':'T','Υ':'U','Φ':'F','Χ':'X','Ψ':'Y','Ω':'W'
  };
  return word => {
    const norm = (word || '').normalize('NFD');
    let out = '';
    for (const ch of norm) {
      if (ch.charCodeAt(0) >= 0x0300 && ch.charCodeAt(0) <= 0x036F) continue;
      out += map[ch] || ch;
    }
    return out;
  };
})();

function parseMorpheusAnalyses(json) {
  const out = [];
  const ann = json && json.RDF && json.RDF.Annotation;
  if (!ann) return out;
  const bodies = [].concat(ann.Body || ann.body || []);
  for (const body of bodies) {
    const entry = body && body.rest && body.rest.entry;
    if (!entry) continue;
    const lemma = entry.dict?.hdwd?.$;
    const dictPos = entry.dict?.pofs?.$;
    const dictGend = entry.dict?.gend?.$;
    const infls = [].concat(entry.infl || [{}]);
    for (const infl of infls) {
      const v = k => infl?.[k]?.$;
      out.push({
        lemma: lemma || '',
        pos: v('pofs') || dictPos || '',
        gender: v('gend') || dictGend || '',
        case: v('case') || '',
        number: v('num') || '',
        tense: v('tense') || '',
        mood: v('mood') || '',
        voice: v('voice') || '',
        person: v('pers') || ''
      });
    }
  }
  return out;
}

function parseDefinitions(html) {
  const defs = [];
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const row of doc.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 4) continue;
      const last = cells[cells.length - 1].textContent.trim();
      const lemmaLink = cells[0].querySelector('a');
      const lemma = lemmaLink ? lemmaLink.textContent.trim() : cells[0].textContent.trim();
      if (last && lemma && !/^\d/.test(last) && last !== 'Min. Freq.') {
        defs.push({ lemma, def: last });
      }
    }
  } catch { /* ignore */ }
  return defs;
}

const morphCache = {};

function Lexicon({ tok, lang, onClose, onAddBookmark }) {
  const [analyses, setAnalyses] = useState(null);
  const [definition, setDefinition] = useState('');
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!tok) { setAnalyses(null); setDefinition(''); return; }
    const word = tok.clean || tok.w;
    if (!word) { setAnalyses([]); return; }
    const isLatin = (lang === 'lat' || lang === 'la' || lang === 'latin');
    const cacheKey = `${lang || 'grc'}:${word}`;
    const my = ++seqRef.current;
    if (morphCache[cacheKey]) {
      setAnalyses(morphCache[cacheKey].analyses);
      setDefinition(morphCache[cacheKey].definition);
      return;
    }
    setBusy(true);
    setAnalyses(null);
    setDefinition('');
    (async () => {
      try {
        const langParam = isLatin ? 'latin' : 'greek';
        const r = await fetch(`/api/morph?word=${encodeURIComponent(word)}&lang=${langParam}`);
        const data = await r.json();
        if (my !== seqRef.current) return;
        const a = parseMorpheusAnalyses(data);
        // Pick the first lemma and try a definition.
        let def = '';
        const lemma = a.find(x => x.lemma)?.lemma;
        if (lemma) {
          try {
            const lookup = isLatin ? lemma : greekToBeta(lemma);
            const dr = await fetch(`/api/define?word=${encodeURIComponent(lookup)}&lang=${langParam}`);
            if (my !== seqRef.current) return;
            const html = await dr.text();
            const defs = parseDefinitions(html);
            if (defs.length) def = defs[0].def;
          } catch {}
        }
        morphCache[cacheKey] = { analyses: a, definition: def };
        if (my === seqRef.current) {
          setAnalyses(a);
          setDefinition(def);
        }
      } catch (e) {
        if (my === seqRef.current) setAnalyses([]);
      } finally {
        if (my === seqRef.current) setBusy(false);
      }
    })();
  }, [tok && tok.id, lang]);

  return (
    <aside className={`lex ${tok ? 'open' : ''}`}>
      {tok && (
        <>
          <div className="lex-head">
            <span className="label">Dictionary</span>
            <button className="lex-close" onClick={onClose}>×</button>
          </div>
          <div className="form">{tok.w.replace(/[,·.;]+$/, '')}</div>
          {analyses === null && busy && (
            <div style={{ color: 'var(--ink-3)', fontStyle: 'italic', marginTop: 16 }}>Looking up…</div>
          )}
          {analyses && analyses.length === 0 && (
            <div style={{ color: 'var(--ink-3)', fontStyle: 'italic', marginTop: 16 }}>No dictionary entry found.</div>
          )}
          {analyses && analyses.length > 0 && (
            <>
              <div className="lemma-row">
                <span>FORM OF</span>
                <span className="arrow">→</span>
                <span className="lemma">{analyses[0].lemma}</span>
              </div>
              <h4>Parsing</h4>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: 'var(--ink-2)', marginBottom: 22, letterSpacing: 0.04 }}>
                {[analyses[0].pos, analyses[0].number, analyses[0].gender, analyses[0].case, analyses[0].tense, analyses[0].mood, analyses[0].voice, analyses[0].person].filter(Boolean).join(', ')}
              </div>
              {definition && <>
                <h4>Gloss</h4>
                <div className="gloss-text">{definition}</div>
              </>}
              {analyses.length > 1 && (
                <>
                  <h4>Other readings</h4>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.6 }}>
                    {analyses.slice(1, 4).map((a, i) => (
                      <div key={i}>
                        <span style={{ color: 'var(--ink-2)' }}>{a.lemma}</span>
                        {' — '}
                        {[a.pos, a.case, a.number, a.tense, a.mood, a.voice, a.person].filter(Boolean).join(', ')}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          <div className="lex-actions">
            <button className="lex-btn" onClick={onAddBookmark}>＋ Bookmark line</button>
            {analyses && analyses[0]?.lemma && (
              <button className="lex-btn primary" onClick={() => window.open(`https://logeion.uchicago.edu/${encodeURIComponent(analyses[0].lemma)}`, '_blank')}>
                Logeion ↗
              </button>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

// ── BookmarkDialog ───────────────────────────────────────────────────────────

function BookmarkDialog({ line, passage, prefilledNote, onSave, onCancel }) {
  const [note, setNote] = useState(prefilledNote || '');
  const greekText = line.greek.map(t => t.w).join(' ');
  const transText = line.translation.map(t => t.t).join(' ');
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="sub">{passage.workEn} · {passage.section} · Line {line.n}</div>
        <h3 style={{ fontFamily: "'GFS Neohellenic', serif", fontSize: 22, lineHeight: 1.4 }}>{greekText}</h3>
        {transText && (
          <div style={{ fontStyle: 'italic', color: 'var(--ink-3)', fontSize: 14, marginTop: 4, marginBottom: 16 }}>{transText}</div>
        )}
        <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note (optional)…" autoFocus />
        <div className="dialog-actions">
          <button className="lex-btn" style={{ flex: 'none', padding: '8px 16px' }} onClick={onCancel}>Cancel</button>
          <button className="lex-btn primary" style={{ flex: 'none', padding: '8px 16px' }} onClick={() => onSave(note)}>Save bookmark</button>
        </div>
      </div>
    </div>
  );
}

// ── Library search overlay ───────────────────────────────────────────────────

function highlight(text, query) {
  if (!query) return text;
  const q = stripDiacritics(query);
  const norm = stripDiacritics(text);
  const i = norm.indexOf(q);
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

function LibrarySearchOverlay({ library, currentWork, toc, onClose, onPickWork, onJump }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActive(0); }, [q]);

  const results = useMemo(() => {
    const query = q.trim();
    const Q = stripDiacritics(query);

    // Default empty state: show current work's sections (if any) + a few works as a teaser.
    if (!query) {
      const out = [];
      if (currentWork && toc.length) {
        for (const e of toc.slice(0, 8)) {
          out.push({
            kind: 'section',
            workUrn: currentWork.workUrn,
            sectionNum: e.num,
            title: `${currentWork.workEn} · ${e.label}`,
            subtitle: currentWork.authorEn,
            snippet: ''
          });
        }
      }
      for (const w of library.slice(0, 12)) {
        out.push({
          kind: 'work',
          work: w,
          title: w.workEn,
          subtitle: `${w.authorEn}${w.engUrn ? ' · translation available' : ''}`,
          snippet: w.work
        });
      }
      return out;
    }

    const out = [];
    for (const w of library) {
      const titleHit = stripDiacritics(w.workEn).includes(Q) || stripDiacritics(w.work).includes(Q);
      const authorHit = stripDiacritics(w.authorEn).includes(Q) || stripDiacritics(w.author).includes(Q);
      if (titleHit || authorHit) {
        out.push({
          kind: 'work',
          work: w,
          title: titleHit ? w.workEn : w.authorEn,
          subtitle: `${w.authorEn}${w.engUrn ? ' · translation available' : ''}`,
          snippet: w.work
        });
        if (out.length >= 80) break;
      }
    }
    return out;
  }, [q, library, currentWork, toc]);

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && results[active]) {
      e.preventDefault();
      pick(results[active]);
    }
  }
  function pick(r) {
    if (r.kind === 'work') onPickWork(r.work);
    else onJump(r.workUrn, r.sectionNum);
  }

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={e => e.stopPropagation()}>
        <div className="search-input-row">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search by author, work title…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <div className="search-meta">
          {q.trim() === ''
            ? <span>Browse the library, or type to search · {library.length} works available</span>
            : <span>{results.length} {results.length === 1 ? 'result' : 'results'} for “{q}”</span>}
        </div>
        <div className="search-results">
          {results.length === 0 && q.trim() !== '' && (
            <div className="search-empty">No matches. Try an English keyword or an author name.</div>
          )}
          {results.map((r, i) => (
            <div
              key={`${r.kind}-${r.title}-${i}`}
              className={`search-result ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r)}
            >
              <div className="sr-kind">{r.kind === 'work' ? 'Work' : 'Section'}</div>
              <div className="sr-body">
                <div className="sr-title">
                  {highlight(r.title, q)}
                  <span className="sr-subtitle">{r.subtitle}</span>
                </div>
                {r.snippet && <div className="sr-greek">{highlight(r.snippet, q)}</div>}
              </div>
              <div className="sr-arrow">↵</div>
            </div>
          ))}
        </div>
        <div className="search-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// ── Icons (preserved from prototype) ────────────────────────────────────────

function Icon({ name }) {
  const c = 'currentColor';
  if (name === 'moon')     return <svg viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.4"><path d="M13 9.5A5 5 0 0 1 6.5 3a5 5 0 1 0 6.5 6.5z"/></svg>;
  if (name === 'sun')      return <svg viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>;
  if (name === 'sun-warm') return <svg viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.4"><circle cx="8" cy="8" r="3.2" fill={c} fillOpacity="0.15"/><circle cx="8" cy="8" r="3"/><path d="M8 2v1.6M8 12.4V14M2 8h1.6M12.4 8H14"/></svg>;
  if (name === 'gloss')    return <svg viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.4"><path d="M2 4h12M2 8h8M2 12h12"/><circle cx="13" cy="8" r="1" fill={c}/></svg>;
  if (name === 'pin-on')   return <svg viewBox="0 0 16 16" fill={c} stroke="none"><path d="M9.5 1.5l-1 1 .8.8-3.4 3.4-1.4-.4-.7.7 2.6 2.6L3 13l3.4-2.4 2.6 2.6.7-.7-.4-1.4 3.4-3.4.8.8 1-1L9.5 1.5z"/></svg>;
  if (name === 'pin-off')  return <svg viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.3"><path d="M9.5 1.5l-1 1 .8.8-3.4 3.4-1.4-.4-.7.7 2.6 2.6L3 13l3.4-2.4 2.6 2.6.7-.7-.4-1.4 3.4-3.4.8.8 1-1L9.5 1.5z"/></svg>;
  if (name === 'search')   return <svg viewBox="0 0 16 16" fill="none" stroke={c} strokeWidth="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/></svg>;
  return null;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
