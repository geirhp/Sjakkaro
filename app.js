    /*********************
     * STATE
     *********************/
    const openingTextCache = new Map();
    let current='opening', board, game, sanList=[], idx=0, dkOn=false;
    let evaluations=[], loadedGame=null, engine=null, analysisResolver=null, lastInfo={score:null,depth:null,pv:null};
    let enhancedEvals=[], gameOpeningInfo=null; // Lagrer utvidet evalueringsdata og åpningsinfo
    let fileGameList=[];
    let timeSpentList = []; // Lagrer tidsbruk per trekk i sekunder
    let pgnAnnotations = {}; // Lagrer utparsede annotasjoner og pedagogiske data

    // ==== Elevens ratingnivå (persistens i localStorage) ====
    let elevRating = parseInt(localStorage.getItem('elevRating'), 10) || SJAKKARO_CONFIG.defaultElevRating;

    function setElevRating(rating) {
      const val = parseInt(rating, 10);
      if (!isNaN(val) && val >= 400 && val <= 2400) {
        elevRating = val;
        localStorage.setItem('elevRating', String(val));
        console.log('ElevRating satt til:', elevRating);
      } else {
        console.warn('Ugyldig elevRating:', rating);
      }
    }

    // Puzzle system variables
    let allPuzzles = [];
    let isInPuzzleMode = false;
    let currentPuzzle = null;
    let puzzleSolutionMoves = [];
    let currentPuzzleStep = 0;
    let savedAnalysisFEN = '';
    let chatHistory = [];
    let selectedOpeningDb = 'lichess';
    const SERVER_URL = SJAKKARO_CONFIG.SERVER_URL;

    // === API-keys i localStorage (ingen backend) ===
    function getGeminiApiKey() {
      return localStorage.getItem('geminiApiKey') ?? '';
    }
    function setGeminiApiKey(k) {
      localStorage.setItem('geminiApiKey', (k || '').trim());
    }
    function getGroqApiKey() {
      return localStorage.getItem('groqApiKey') ?? '';
    }
    function setGroqApiKey(k) {
      localStorage.setItem('groqApiKey', (k || '').trim());
    }

    // === Provider-tabell (kan utvides) ===
    const AI_PROVIDERS = {
      'gemini-2.5-flash-lite': {
        name: 'Gemini 2.5 Flash-Lite',
        provider: 'gemini',
        getApiKey: getGeminiApiKey,
        handler: callGeminiAPI
      },
      'deepseek-r1-distill-llama-70b': {
        name: 'Groq DeepSeek-R1 (70B)',
        provider: 'groq',
        getApiKey: getGroqApiKey,
        handler: callGroqAPI
      }
    };

    // === Aktiv modell (med persistens) ===
    let currentAIModel = localStorage.getItem('aiModel') ?? 'gemini-2.5-flash-lite';
    function setCurrentAIModel(key) {
      currentAIModel = key;
      localStorage.setItem('aiModel', key);
    }

    // ---- Lichess Opening Book Configuration ----
    const OPENING_BOOK = SJAKKARO_CONFIG.openingBook;

    // Opening book cache
    const openingCache = new Map();
    const maxCacheSize = SJAKKARO_CONFIG.maxCacheSize;
    const cacheExpiry = SJAKKARO_CONFIG.cacheExpiry;
    let lastOpeningQuery = 0; // Rate limiting

    // Wikibooks cache for translated content
    const wikibooksCache = new Map();
    const wikibooksCacheExpiry = 7 * SJAKKARO_CONFIG.cacheExpiry; // 1 uke

    // oppdagede UCI-opsjoner
    const engineCaps = { threads:false, options:{} };

    // bruker‑valg for motor
    function getEnginePrefs(){
      const mode = document.querySelector('input[name="mode"]:checked')?.value||'movetime';
      const ms = Math.max(2000, parseInt(document.getElementById('mtInput').value||'3000',10)); // Økt tid for stabilitet
      const depth = Math.max(15, parseInt(document.getElementById('depthInput').value||'20',10)); // Økt dybde
      const mpv = 1; // Kun beste trekk for Lichess-kompatibilitet
      return { mode, ms, depth, mpv };
    }

    function updateOpeningBookConfig() {
      OPENING_BOOK.enabled = document.getElementById('openingEnabled')?.checked ?? true;
      OPENING_BOOK.strategy = document.getElementById('openingStrategy')?.value || 'balanced';
      OPENING_BOOK.minGames = Math.max(50, parseInt(document.getElementById('minGamesInput')?.value || '100', 10));
      OPENING_BOOK.maxPlies = Math.max(10, parseInt(document.getElementById('maxPliesInput')?.value || '20', 10));

      console.log('Opening book config updated:', OPENING_BOOK);
    }

    /********************* PGN Evaluation Detection & Extraction *********************/
    function hasEvaluations(pgnText) {
      // Sjekk om PGN inneholder [%eval] tags
      return /\[%eval\s+[+-]?(?:\d+\.?\d*|#[+-]?\d+)\]/.test(pgnText);
    }

    function extractEvaluationsFromPGN(pgnText) {
      const evals = [];
      const evalRegex = /\[%eval\s+([+-]?(?:\d+\.?\d*|#[+-]?\d+))\]/g;
      let match;

      console.log('Extracting evaluations from PGN...');

      while ((match = evalRegex.exec(pgnText)) !== null) {
        const evalStr = match[1];
        console.log(`Found eval: ${evalStr}`);

        // Håndter mate-evalueringer (#5, #-3, etc.)
        if (evalStr.startsWith('#')) {
          evals.push(evalStr); // Behold mate-format
        } else {
          // Numeriske evalueringer - formater med + for positive verdier
          const num = parseFloat(evalStr);
          if (!isNaN(num)) {
            evals.push(num >= 0 ? `+${num.toFixed(2)}` : num.toFixed(2));
          }
        }
      }

      console.log(`Extracted ${evals.length} evaluations:`, evals);
      return evals;
    }

    function alignEvaluationsWithMoves(extractedEvals, moveCount) {
      // PGN evalueringer starter ofte etter første trekk
      // Vi trenger evaluering for startposisjon (0.00) + alle posisjoner etter trekk
      const alignedEvals = ['0.00']; // Startposisjon

      // Kopier ekstraherte evalueringer
      for (let i = 0; i < moveCount && i < extractedEvals.length; i++) {
        alignedEvals.push(extractedEvals[i]);
      }

      // Hvis vi mangler evalueringer på slutten, bruk siste kjente verdi
      while (alignedEvals.length <= moveCount) {
        const lastEval = alignedEvals[alignedEvals.length - 1];
        alignedEvals.push(lastEval);
      }

      console.log(`Aligned ${alignedEvals.length} evaluations for ${moveCount} moves`);
      return alignedEvals;
    }

    function extractAndCalculateTimeSpent(pgnText, moveCount) {
      // Regex for å hente ut TimeControl (f.eks. "180+2")
      const timeControlMatch = pgnText.match(/\[TimeControl\s+"(\d+)\+?(\d+)?"\]/);
      if (!timeControlMatch) {
        console.log('Ingen TimeControl funnet i PGN');
        return []; // Ingen tidskontroll, kan ikke beregne
      }

      const startTime = parseInt(timeControlMatch[1], 10);
      const increment = parseInt(timeControlMatch[2], 10) || 0;
      console.log(`TimeControl parsed: ${startTime}s + ${increment}s increment`);

      // Regex for å hente ut alle [%clk HH:MM:SS] verdier
      const clkRegex = /\[%clk\s+(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\]/g;
      let match;
      const clockTimesInSeconds = [];

      while ((match = clkRegex.exec(pgnText)) !== null) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseFloat(match[3]);
        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
        clockTimesInSeconds.push(totalSeconds);
      }

      if (clockTimesInSeconds.length === 0) {
        console.log('Ingen [%clk] data funnet i PGN');
        return []; // Ingen klokkedata funnet
      }

      console.log(`Found ${clockTimesInSeconds.length} clock times:`, clockTimesInSeconds.slice(0, 5));

      const timeSpent = [];
      for (let i = 0; i < Math.min(moveCount, clockTimesInSeconds.length); i++) {
        const timeAfterMove = clockTimesInSeconds[i];
        let timeBeforeMove;

        if (i === 0) {
          // Hvits første trekk - start med full tid
          timeBeforeMove = startTime;
        } else if (i === 1) {
          // Svarts første trekk - start med full tid
          timeBeforeMove = startTime;
        } else {
          // Alle påfølgende trekk - forrige spilers tid + increment
          const isWhitesMove = (i % 2 === 0);
          const lastMoveByThisPlayer = isWhitesMove ? i - 2 : i - 2;

          if (lastMoveByThisPlayer >= 0) {
            timeBeforeMove = clockTimesInSeconds[lastMoveByThisPlayer] + increment;
          } else {
            timeBeforeMove = startTime;
          }
        }

        const spent = timeBeforeMove - timeAfterMove;
        timeSpent.push(Math.max(0, spent)); // Sørg for at tiden ikke er negativ
      }

      console.log(`Beregnet tidsbruk for ${timeSpent.length} trekk:`, timeSpent.slice(0, 10));
      return timeSpent;
    }

    function parseAdvancedPGNAnnotations(pgnText) {
      console.log('Starter avansert PGN-parsing...');

      const result = {
        playerInfo: {},
        gameMetadata: {},
        moveAnnotations: [],
        tacticalThemes: new Set(),
        pgnComments: [],
        timeSpentData: []
      };

      // 1. Hent ut player metadata
      const whiteMatch = pgnText.match(/\[White\s+"([^"]+)"\]/);
      const blackMatch = pgnText.match(/\[Black\s+"([^"]+)"\]/);
      const whiteEloMatch = pgnText.match(/\[WhiteElo\s+"([^"]+)"\]/);
      const blackEloMatch = pgnText.match(/\[BlackElo\s+"([^"]+)"\]/);
      const resultMatch = pgnText.match(/\[Result\s+"([^"]+)"\]/);
      const eventMatch = pgnText.match(/\[Event\s+"([^"]+)"\]/);
      const dateMatch = pgnText.match(/\[Date\s+"([^"]+)"\]/);

      if (whiteMatch) result.playerInfo.white = whiteMatch[1];
      if (blackMatch) result.playerInfo.black = blackMatch[1];
      if (whiteEloMatch) result.playerInfo.whiteElo = parseInt(whiteEloMatch[1], 10);
      if (blackEloMatch) result.playerInfo.blackElo = parseInt(blackEloMatch[1], 10);
      if (resultMatch) result.gameMetadata.result = resultMatch[1];
      if (eventMatch) result.gameMetadata.event = eventMatch[1];
      if (dateMatch) result.gameMetadata.date = dateMatch[1];

      // 2. Parse tidsdata
      const timeControlMatch = pgnText.match(/\[TimeControl\s+"([^"]+)"\]/);
      if (timeControlMatch) {
        result.gameMetadata.timeControl = timeControlMatch[1];
      }

      // 3. Hent alle kommentarer og annotasjoner fra trekk-delen
      const movesSection = pgnText.split(/^1\.|\n1\./m).slice(-1)[0] || '';

      // Regex for å finne kommentarer { ... }
      const commentRegex = /\{([^}]+)\}/g;
      let match;
      while ((match = commentRegex.exec(movesSection)) !== null) {
        result.pgnComments.push(match[1].trim());
      }

      // 4. Parse NAGs (Numeric Annotation Glyphs) og symboler
      const nagMap = {
        '!': 'good_move',
        '!!': 'brilliant_move',
        '?': 'mistake',
        '??': 'blunder',
        '!?': 'interesting_move',
        '?!': 'inaccuracy',
        '$1': 'good_move',
        '$2': 'mistake',
        '$3': 'brilliant_move',
        '$4': 'blunder',
        '$5': 'interesting_move',
        '$6': 'inaccuracy'
      };

      // Parse hver trekksekvens
      const movePattern = /(\d+\.+)\s*([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?)([!?]{1,2}|\$\d+)?\s*(?:\{([^}]+)\})?\s*(?:\[%clk\s+([^\]]+)\])?/g;

      let moveIndex = 0;
      while ((match = movePattern.exec(movesSection)) !== null) {
        const [, moveNumber, san, annotation, comment, clock] = match;

        const moveData = {
          index: moveIndex,
          moveNumber: moveNumber.trim(),
          san: san.trim(),
          annotation: null,
          comment: comment ? comment.trim() : null,
          clock: clock ? clock.trim() : null,
          classification: 'normal'
        };

        // Klassifiser trekket basert på annotasjon
        if (annotation) {
          if (nagMap[annotation]) {
            moveData.classification = nagMap[annotation];
            moveData.annotation = annotation;
          }
        }

        // Søk etter taktiske temaer i kommentarer
        if (comment) {
          const themes = extractTacticalThemes(comment);
          themes.forEach(theme => result.tacticalThemes.add(theme));
          moveData.tacticalThemes = themes;
        }

        result.moveAnnotations.push(moveData);
        moveIndex++;
      }

      // 5. Parse evalueringskommentarer for å finne matesekvenser
      result.pgnComments.forEach(comment => {
        if (comment.includes('#') || comment.includes('mate')) {
          const moveIndex = result.pgnComments.indexOf(comment);
          if (result.moveAnnotations[moveIndex]) {
            result.moveAnnotations[moveIndex].isMateSequence = true;
          }
        }
      });

      console.log('PGN-parsing fullført:', {
        spillere: result.playerInfo,
        metadata: result.gameMetadata,
        antallTrekk: result.moveAnnotations.length,
        kommentarer: result.pgnComments.length,
        taktiskeTemaer: Array.from(result.tacticalThemes)
      });

      return result;
    }

    function extractTacticalThemes(comment) {
      const themes = [];
      const validThemes = SJAKKARO_CONFIG.puzzles.validThemes;
      const lowerComment = comment.toLowerCase();

      // Søk etter kjente taktiske mønstre i kommentarer
      const themePatterns = {
        fork: ['gaffel', 'fork', 'double attack'],
        pin: ['binding', 'pin', 'bundet'],
        skewer: ['spyd', 'skewer', 'gjennomstikk'],
        discoveredAttack: ['avdekket angrep', 'discovered', 'avdekking'],
        sacrifice: ['offer', 'sacrifice', 'oppofring'],
        mateIn1: ['matt i 1', 'mate in 1', '#1'],
        mateIn2: ['matt i 2', 'mate in 2', '#2'],
        mateIn3: ['matt i 3', 'mate in 3', '#3'],
        backRankMate: ['grunnlinjematt', 'back rank', 'bakerste rekke'],
        hangingPiece: ['hengjer', 'hanging', 'ubeskyttet'],
        trappedPiece: ['fanget', 'trapped', 'innestegt']
      };

      Object.entries(themePatterns).forEach(([theme, patterns]) => {
        if (validThemes.includes(theme)) {
          patterns.forEach(pattern => {
            if (lowerComment.includes(pattern)) {
              themes.push(theme);
            }
          });
        }
      });

      return [...new Set(themes)]; // Fjern duplikater
    }

    function showEvaluationSource(source) {
        const panelTitle = document.querySelector('.panel-title');
        if (panelTitle) {
            panelTitle.textContent = 'Trekk';
        }
    }

    /********************* Lichess Opening Book API *********************/
    async function queryLichessOpeningBook(fen) {
      if (!OPENING_BOOK.enabled) return null;

      // Sjekk cache først
      const cacheKey = `${fen}-${selectedOpeningDb}`;
      if (openingCache.has(cacheKey)) {
        const cached = openingCache.get(cacheKey);
        if (Date.now() - cached.timestamp < cacheExpiry) {
          console.log('Using cached opening data for', cacheKey);
          return cached.data;
        } else {
          openingCache.delete(cacheKey);
        }
      }

      // Rate limiting - vente minst 1 sekund mellom forespørsler
      const now = Date.now();
      const timeSinceLastQuery = now - lastOpeningQuery;
      if (timeSinceLastQuery < 1000) {
        await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLastQuery));
      }
      lastOpeningQuery = Date.now();

      try {
        const baseUrl = `https://explorer.lichess.ovh/${selectedOpeningDb}`;
        const params = new URLSearchParams({
          variant: 'standard',
          fen: fen,
          speeds: OPENING_BOOK.speeds,
          ratings: OPENING_BOOK.ratings,
          moves: '10',
          topGames: '0',
          recentGames: '0'
        });

        // Note: We use the FEN which already represents the position after moves.
        // No need for 'play' parameter when using FEN.

        console.log(`Querying Lichess opening book: ${baseUrl}?${params}`);
        const response = await fetch(`${baseUrl}?${params}`);

        if (!response.ok) {
          throw new Error(`Lichess API error: ${response.status}`);
        }

        const data = await response.json();

        // Beregn statistikk for trekkene
        if (data.moves) {
          data.moves = data.moves.map(move => {
            const total = (move.white || 0) + (move.draws || 0) + (move.black || 0);
            const winRate = total > 0 ? (move.white || 0) / total : 0;
            const drawRate = total > 0 ? (move.draws || 0) / total : 0;
            const performance = winRate * 1.0 + drawRate * 0.5; // Performance score
            return {
              ...move,
              total,
              winRate,
              drawRate,
              performance
            };
          });
        }

        // Cache resultatet
        if (openingCache.size >= maxCacheSize) {
          // Fjern eldste cache-entry
          const firstKey = openingCache.keys().next().value;
          openingCache.delete(firstKey);
        }
        openingCache.set(cacheKey, {
          data,
          timestamp: Date.now()
        });

        console.log('Lichess opening data retrieved with', data.moves?.length || 0, 'moves');
        return data;
      } catch (error) {
        console.error('Error querying Lichess opening book:', error);
        return null;
      }
    }

    function calculateOpeningEvaluation(bookData) {
      if (!bookData || !bookData.moves || bookData.moves.length === 0) return null;

      // Beregn gjennomsnittlig performance basert på alle trekk
      const totalGames = bookData.moves.reduce((sum, move) => sum + move.total, 0);
      if (totalGames < OPENING_BOOK.minGames) return null;

      const weightedPerformance = bookData.moves.reduce((sum, move) => {
        return sum + (move.performance * move.total);
      }, 0) / totalGames;

      // Konverter performance til centipawn-lignende score
      // 0.5 = jevnt (0.00), 0.6 = +hvit (+50), 0.4 = +svart (-50)
      const centipawns = (weightedPerformance - 0.5) * 100;
      return centipawns >= 0 ? `+${centipawns.toFixed(2)}` : centipawns.toFixed(2);
    }

    function selectBestOpeningMove(bookData) {
      if (!bookData || !bookData.moves || bookData.moves.length === 0) return null;

      const moves = bookData.moves.filter(m => m.total >= 10); // Filtrer sjeldne trekk
      if (!moves.length) return bookData.moves[0];

      switch (OPENING_BOOK.strategy) {
        case 'popular':
          return moves.sort((a, b) => b.total - a.total)[0];

        case 'performance':
          return moves.sort((a, b) => b.performance - a.performance)[0];

        case 'balanced':
          // Kombiner popularitet (30%) og performance (70%)
          const scored = moves.map(m => ({
            ...m,
            score: (m.total / Math.max(...moves.map(x => x.total))) * 0.3 + m.performance * 0.7
          }));
          return scored.sort((a, b) => b.score - a.score)[0];

        case 'random':
          // Vektet tilfeldig basert på performance
          const weights = moves.map(m => Math.max(0.1, m.performance * Math.sqrt(m.total)));
          const totalWeight = weights.reduce((sum, w) => sum + w, 0);
          const rand = Math.random() * totalWeight;
          let cumulative = 0;
          for (let i = 0; i < moves.length; i++) {
            cumulative += weights[i];
            if (rand <= cumulative) return moves[i];
          }
          return moves[0];

        default:
          return moves.sort((a, b) => b.total - a.total)[0];
      }
    }

    /********************* Wikibooks Integration *********************/
    function formatMovesForWikibooks(moves) {
      // Konverter ["e4", "e5", "Nf3", "Nc6"] til "1._e4/1...e5/2._Nf3/2...Nc6"
      let formatted = "";
      for (let i = 0; i < moves.length; i += 2) {
        const moveNum = Math.floor(i / 2) + 1;
        formatted += `${moveNum}._${moves[i]}`;
        if (moves[i + 1]) {
          formatted += `/${moveNum}...${moves[i + 1]}`;
        }
        if (i + 2 < moves.length) formatted += "/";
      }
      return formatted;
    }

    async function fetchWikibooksOpening(moveSequence) {
      if (!moveSequence || moveSequence.length === 0) return null;

      try {
        // Konverter trekk til Wikibooks URL-format
        const urlPath = formatMovesForWikibooks(moveSequence);
        const wikiUrl = `Chess_Opening_Theory/${urlPath}`;

        console.log(`Fetching Wikibooks: ${wikiUrl}`);

        // Bruk Wikipedia API for å hente Wikibooks-innhold
        const apiUrl = `https://en.wikibooks.org/w/api.php?action=query&format=json&origin=*&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(wikiUrl)}`;

        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error(`Wikibooks API error: ${response.status}`);

        const data = await response.json();
        const pages = data.query?.pages;

        if (!pages) return null;

        const pageId = Object.keys(pages)[0];
        const page = pages[pageId];

        if (page.missing) {
          console.log(`Wikibooks page not found: ${wikiUrl}`);
          return null;
        }

        // Sjekk om extract faktisk finnes og har innhold
        let extract = page.extract?.trim() ?? '';
        let title = page.title;

        if (!extract) {
          const fallbackUrl = `https://en.wikibooks.org/w/api.php?action=query&format=json&origin=*&prop=extracts&explaintext&redirects=1&titles=${encodeURIComponent(wikiUrl)}`;
          const fallbackResponse = await fetch(fallbackUrl);

          if (fallbackResponse.ok) {
            const fallbackData = await fallbackResponse.json();
            const fallbackPages = fallbackData.query?.pages;

            if (fallbackPages) {
              const fallbackPageId = Object.keys(fallbackPages)[0];
              const fallbackPage = fallbackPages[fallbackPageId];

              if (!fallbackPage?.missing) {
                const fallbackExtract = fallbackPage.extract?.trim() ?? '';
                if (fallbackExtract) {
                  extract = fallbackExtract;
                  title = fallbackPage.title ?? title;
                }
              }
            }
          }
        }

        if (!extract) {
          console.log(`Wikibooks page found but no extract content: ${wikiUrl}`);
          return null;
        }

        return {
          title,
          extract,
          url: `https://en.wikibooks.org/wiki/${wikiUrl.replace(/ /g, '_')}`
        };

      } catch (error) {
        console.error('Wikibooks fetch error:', error);
        return null;
      }
    }


    async function loadChessDictionary() {
      try {
        const response = await fetch('/docs/norsk_sjakk_ordbok.csv');
        if (!response.ok) throw new Error('Could not load chess dictionary');

        const csvText = await response.text();
        const lines = csvText.split('\n');
        const translations = [];

        // Parse CSV (skip header)
        for (let i = 2; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Simple CSV parsing - kan forbedres ved behov
          const match = line.match(/^"?([^"]+)"?\s+"[^"]*"\s+"[^"]*"\s+"?([^"]*)"?$/);
          if (match) {
            const norwegianTerm = match[1].trim();
            const englishNote = match[2].trim();

            // Trekk ut engelske termer fra "Falsk Venn"-kolonnen
            if (englishNote && englishNote !== 'undefined') {
              const englishTerms = englishNote.match(/[A-Z][a-z]+/g);
              if (englishTerms) {
                englishTerms.forEach(eng => {
                  translations.push(`${eng} → ${norwegianTerm}`);
                });
              }
            }
          }
        }

        return translations.slice(0, 50).join('\n'); // Begrens til de viktigste termene

      } catch (error) {
        console.error('Dictionary loading error:', error);
        // Fallback til hard-kodet viktige termer
        return `Opening → Åpning
Defense → Forsvar
Attack → Angrep
Control → Kontroll
Development → Utvikling
Center → Sentrum
Piece → Brikke
Pawn → Bonde
Knight → Springer
Bishop → Løper
Rook → Tårn
Queen → Dronning
King → Konge
Gambit → Gambit
Strategy → Strategi
Tactics → Taktikk`;
      }
    }

    async function translateOpeningInfo(englishContent) {
      if (!englishContent) return englishContent;

      try {
        const dictionary = await loadChessDictionary();

        const prompt = SJAKKARO_PROMPTS.translateOpening(dictionary, englishContent);

        const translatedText = await getAICompletion(prompt);

        return translatedText || englishContent;

      } catch (error) {
        console.error('Translation error:', error);
        return englishContent; // Fallback til engelsk
      }
    }

    async function getOpeningTheory(moveSequence) {
      if (!moveSequence || moveSequence.length === 0) return null;

      const cacheKey = moveSequence.join('_');

      // Sjekk cache først
      if (wikibooksCache.has(cacheKey)) {
        const cached = wikibooksCache.get(cacheKey);
        if (Date.now() - cached.timestamp < wikibooksCacheExpiry) {
          console.log('Using cached Wikibooks data for', cacheKey);
          return cached.data;
        }
      }

      try {
        // Hent fra Wikibooks
        const wikiContent = await fetchWikibooksOpening(moveSequence);
        if (!wikiContent) return null;

        // Oversett til norsk
        const translatedContent = await translateOpeningInfo(wikiContent.extract);

        // Håndter tilfeller hvor oversettelsen feiler
        const safeTranslatedContent = translatedContent || '';
        console.log('Translation result:', { original: wikiContent.extract?.substring(0, 100), translated: safeTranslatedContent?.substring(0, 100) });

        const result = {
          ...wikiContent,
          translatedExtract: safeTranslatedContent,
          character: extractOpeningCharacter(safeTranslatedContent),
          plans: extractPlans(safeTranslatedContent)
        };

        // Cache resultatet
        if (wikibooksCache.size >= maxCacheSize) {
          const firstKey = wikibooksCache.keys().next().value;
          wikibooksCache.delete(firstKey);
        }

        wikibooksCache.set(cacheKey, {
          data: result,
          timestamp: Date.now()
        });

        console.log('Wikibooks theory loaded and translated for', cacheKey);
        return result;

      } catch (error) {
        console.error('Opening theory fetch error:', error);
        return null;
      }
    }

    function extractOpeningCharacter(text) {
      // Enkel parsing for å finne åpningskarakteristikk
      if (!text || typeof text !== 'string') {
        return '';
      }
      const sentences = text.split('. ').slice(0, 2);
      return sentences.join('. ') + (sentences.length > 0 ? '.' : '');
    }

    function extractPlans(text) {
      // Enkel parsing for å finne planer (kan forbedres)
      const whitePlans = [];
      const blackPlans = [];

      if (!text || typeof text !== 'string') {
        return { white: whitePlans, black: blackPlans };
      }

      // Look for common plan indicators
      const whiteKeywords = ['hvit', 'white', 'first player'];
      const blackKeywords = ['svart', 'black', 'second player'];

      const sentences = text.toLowerCase().split('.');

      sentences.forEach(sentence => {
        if (whiteKeywords.some(kw => sentence.includes(kw))) {
          if (sentence.length < 100 && sentence.length > 10) {
            whitePlans.push(sentence.trim());
          }
        } else if (blackKeywords.some(kw => sentence.includes(kw))) {
          if (sentence.length < 100 && sentence.length > 10) {
            blackPlans.push(sentence.trim());
          }
        }
      });

      return {
        white: whitePlans.slice(0, 3),
        black: blackPlans.slice(0, 3)
      };
    }

    /********************* Chat Functions *********************/
    // NYE FUNKSJONER FOR CHAT

    // Hovedfunksjon for å håndtere sending av meldinger
    async function handleChatMessage() {
        const chatInput = document.getElementById('chatInput');
        const userMessage = chatInput.value.trim();
        if (!userMessage) return;

        appendMessageToChat(userMessage, 'user');
        chatInput.value = '';
        showLoadingInChat();

        // Samle all nødvendig kontekst
        const currentFEN = game.fen();
        const whitePlayer = loadedGame.white || 'Hvit';
        const blackPlayer = loadedGame.black || 'Svart';

        // Legg til brukerens melding i historikken
        chatHistory.push({ role: 'user', content: userMessage });

        try {
            // Hent svar fra AI med full kontekst
            const response = await getAIChatResponse(chatHistory, currentFEN, whitePlayer, blackPlayer);
            // Legg til AI-ens svar i historikken
            chatHistory.push({ role: 'ai', content: response });
            appendMessageToChat(response, 'ai');
        } catch (error) {
            console.error('Klarte ikke å hente AI-svar:', error);
            appendMessageToChat('Beklager, noe gikk galt.', 'ai');
        } finally {
            removeLoadingFromChat();
        }
    }

    // Funksjon for å kalle Gemini API for et chat-svar
    async function getAIChatResponse(chatHistory, currentFEN, whitePlayer, blackPlayer) {
        try {
            const analysisContext = document.getElementById('explainBox').innerText;

            // Formater chat-historikken for prompten
            const formattedHistory = chatHistory.map(msg =>
                `${msg.role === 'user' ? 'Elev' : 'Sjakkaro'}: ${msg.content}`
            ).join('\n');

            // Bruk prompt fra eksterne filen
            const chatPrompt = SJAKKARO_PROMPTS.chatResponse(analysisContext, whitePlayer, blackPlayer, currentFEN, formattedHistory, pgnAnnotations, idx);

            return await getAICompletion(chatPrompt);
        } catch (e) {
            console.error('Chat error:', e);
            return "Beklager, jeg klarte ikke å behandle spørsmålet ditt akkurat nå.";
        }
    }

    // Hjelpefunksjoner for å oppdatere chat-vinduet
    function appendMessageToChat(message, sender) {
        const chatHistory = document.getElementById('chatHistory');
        const messageDiv = document.createElement('div');
        messageDiv.style.marginBottom = '10px';
        messageDiv.innerHTML = `<strong>${sender === 'user' ? 'Du' : 'AI-Coach'}:</strong><br>${message.replace(/\n/g, '<br>')}`;
        chatHistory.appendChild(messageDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight; // Scroll til bunnen
    }

    function showLoadingInChat() {
        const chatHistory = document.getElementById('chatHistory');
        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'chatLoading';
        loadingDiv.innerHTML = `<span class="spinner"></span> AI-coachen tenker...`;
        chatHistory.appendChild(loadingDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function removeLoadingFromChat() {
        const loadingDiv = document.getElementById('chatLoading');
        if (loadingDiv) loadingDiv.remove();
    }

    /********************* AI Abstraction Layer *********************/
    // Sentralt inngangspunkt for all AI-kommunikasjon
    async function getAICompletion(prompt, opts = {}) {
      const provider = AI_PROVIDERS[currentAIModel];
      if (!provider) return `Feil: AI-leverandør '${currentAIModel}' ikke funnet.`;

      const apiKey = provider.getApiKey();
      if (!apiKey) return 'Mangler API-nøkkel for valgt AI-leverandør. Åpne innstillinger og legg inn nøkkelen.';

      try {
        return await provider.handler(prompt, currentAIModel, apiKey, opts);
      } catch (e) {
        console.error(`Error with AI provider ${currentAIModel}:`, e);
        return `Det oppstod en feil med AI-tjenesten (${currentAIModel}).`;
      }
    }

    // Adapter: Gemini API
    async function callGeminiAPI(prompt, modelId, apiKey, opts = {}) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }]}],
          generationConfig: {
            temperature: opts.temperature ?? 0.4,
            maxOutputTokens: opts.max_tokens ?? 1024
          }
        })
      });

      const data = await r.json();
      if (!r.ok || !data?.candidates?.[0]) {
        console.error('Gemini error:', r.status, data);
        throw new Error(data?.error?.message || 'Gemini API call failed');
      }
      return data.candidates[0].content.parts[0].text;
    }

    // Adapter: Groq API (OpenAI-kompatibelt)
    async function callGroqAPI(prompt, modelId, apiKey, opts = {}) {
      const url = 'https://api.groq.com/openai/v1/chat/completions';
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: 'Du er en norsk sjakktrener. Svar kort, presist og pedagogisk.' },
            { role: 'user', content: prompt }
          ],
          temperature: opts.temperature ?? 0.4,
          max_tokens: opts.max_tokens ?? 4096
        })
      });

      const data = await r.json();
      if (!r.ok || !data?.choices?.[0]?.message?.content) {
        console.error('Groq error:', r.status, data);
        throw new Error(data?.error?.message || 'Groq API call failed');
      }
      return data.choices[0].message.content;
    }

    // Database selector handler
    function handleDbChange() {
        selectedOpeningDb = document.querySelector('input[name="openingDb"]:checked').value;
        console.log(`Opening database changed to: ${selectedOpeningDb}`);
        openingTextCache.clear();
        updateDynamicOpeningInfo();
    }

    /********************* AI Model Selector Functions *********************/
    function populateAIModelSelector() {
      const sel = document.getElementById('aiModelSelector');
      if (!sel) return;
      sel.innerHTML = '';
      for (const key in AI_PROVIDERS) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = AI_PROVIDERS[key].name;
        if (key === currentAIModel) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', e => {
        setCurrentAIModel(e.target.value);
        console.log('AI model switched to:', currentAIModel);
      });
    }

    function loadAIKeyInputs() {
      const gIn = document.getElementById('geminiApiKeyInput');
      const qIn = document.getElementById('groqApiKeyInput');
      if (gIn) gIn.value = getGeminiApiKey();
      if (qIn) qIn.value = getGroqApiKey();
    }

    // Kall denne fra modalens "Lagre"-knapp
    function saveAISettingsFromModal() {
      const gIn = document.getElementById('geminiApiKeyInput');
      const qIn = document.getElementById('groqApiKeyInput');
      if (gIn) setGeminiApiKey(gIn.value);
      if (qIn) setGroqApiKey(qIn.value);
      // re-valider aktiv provider etter lagring
      const p = AI_PROVIDERS[currentAIModel];
      if (p && !p.getApiKey()) {
        alert('Husk å legge inn API-nøkkel for valgt modell før bruk.');
      }
    }

    /********************* Opening Info Panel Update *********************/
    async function updateDynamicOpeningInfo() {
      if (!OPENING_BOOK.enabled || isInPuzzleMode || sanList.length === 0) {
        document.getElementById('openingInfoPanel').style.display = 'none';
        return;
      }

      const panel = document.getElementById('openingInfoPanel');
      const aiTextEl = document.getElementById('aiOpeningText');
      const analysisBtn = document.getElementById('btnPositionAnalysis');
      if (analysisBtn) analysisBtn.disabled = true; // default: av

      const fen = game.fen();
      const bookData = await queryLichessOpeningBook(fen);

      if (!bookData || !bookData.moves || bookData.moves.length === 0) {
        panel.style.display = 'none';
        return;
      }

      panel.style.display = 'block';
      const nameEl = document.getElementById('openingName');
      if (nameEl) {
        if (bookData.opening) {
          const eco = bookData.opening.eco ? `${bookData.opening.eco}: ` : '';
          nameEl.textContent = `${eco}${bookData.opening.name}`;
        } else {
          nameEl.textContent = 'Åpningsstatistikk';
        }
      }

      // Oppdater stats
      updateOpeningStatsUI(bookData);

      // Sjekk Wikibooks-teori for trekksekvensen
      const moveSequence = game.history().slice(0, idx);
      const theoryData = await getOpeningTheory(moveSequence);

      // KUN GENERER AI-TEKST HVIS WIKIBOOKS HAR DATA
      if (theoryData && theoryData.translatedExtract && theoryData.translatedExtract.trim().length > 0) {
        aiTextEl.innerHTML = `<span class="spinner"></span> Laster AI-forklaring...`;
        const text = await getAIOpeningMoveExplanation(bookData, theoryData);
        aiTextEl.textContent = text || '';
        if (analysisBtn) analysisBtn.disabled = true;  // finnes åpningstekst → analyseknapp av
      } else {
        aiTextEl.textContent = '';                      // ingen åpningstekst
        if (analysisBtn) analysisBtn.disabled = false;  // aktiver manuell analyse
      }
    }

    function updateOpeningStatsUI(bookData) {
      const container = document.getElementById('openingStatsContainer');
      container.innerHTML = ''; // Tøm gammelt innhold

      // Tomt datasett -> vis beskjed og returner
      if (!bookData || !bookData.moves || bookData.moves.length === 0) {
        container.innerHTML = '<p style="font-size:12px; color:var(--muted);">Ingen statistikk for denne stillingen.</p>';
        return;
      }

      // --- START ENDRING (struktur og robusthet) ---

      // Beregn totals for headeren fra white/draws/black (mer robust enn å summere moves)
      const headerTotals = {
        white: Number(bookData.white || 0),
        draws: Number(bookData.draws || 0),
        black: Number(bookData.black || 0)
      };
      const headerTotalGames = headerTotals.white + headerTotals.draws + headerTotals.black;

      // Fallback: hvis headerTotalGames mangler men moves finnes, bruk sum(moves.total)
      const sumMoves = bookData.moves.reduce((s, m) => s + Number(m.total || 0), 0);
      const totalGamesForBars = headerTotalGames > 0 ? headerTotalGames : sumMoves;

      // Finn label for headerlinjen: siste SAN eller "Start"
      let lastMoveSan = 'Start';
      try {
        // Forventer at `game` (Chess.js) og `idx` finnes globalt i din app
        if (typeof game !== 'undefined' && game && typeof game.history === 'function') {
          const hist = game.history();
          const i = (typeof idx === 'number' ? idx : hist.length) - 1;
          lastMoveSan = hist[i] || 'Start';
        }
      } catch (e) {
        // Ignorer og bruk 'Start'
        lastMoveSan = 'Start';
      }

      // 1) Headerlinjen ("Start" / siste trekk)
      // createStatsLine(label, gamesForLine, distObj, totalGames, isHeader?)
      container.appendChild(
        createStatsLine(lastMoveSan, totalGamesForBars, headerTotals, totalGamesForBars, true)
      );

      // 2) Database-velger (radio-knapper) under headerlinjen, lett innrykket
      const dbSelector = document.createElement('div');
      dbSelector.style.cssText = [
        "margin: 2px 0 10px 0",
        "padding-left: 20px",     // innrykk for å ligge under labelen i headerlinjen
        "display: flex",
        "gap: 16px",
        "align-items: center",
        "font-size: 12px"
      ].join(';');

      const currentDb = (typeof selectedOpeningDb !== 'undefined' && selectedOpeningDb) ? selectedOpeningDb : 'lichess';

      dbSelector.innerHTML = `
        <label style="cursor:pointer;">
          <input type="radio" name="openingDb" value="lichess"
                 ${currentDb === 'lichess' ? 'checked' : ''} onchange="handleDbChange()">
          Lichess
        </label>
        <label style="cursor:pointer;">
          <input type="radio" name="openingDb" value="masters"
                 ${currentDb === 'masters' ? 'checked' : ''} onchange="handleDbChange()">
          Masters
        </label>
      `;
      container.appendChild(dbSelector);

      // 3) Topp 3 neste trekk
      const totalGames = totalGamesForBars || sumMoves || 1; // beskyttelse mot 0
      bookData.moves.slice(0, 3).forEach(move => {
        // move: { san, total, white, draws, black, ... }
        const dist = {
          white: Number(move.white || 0),
          draws: Number(move.draws || 0),
          black: Number(move.black || 0)
        };
        const gamesForLine = Number(move.total || (dist.white + dist.draws + dist.black));
        container.appendChild(
          createStatsLine(move.san, gamesForLine, dist, totalGames)
        );
      });

      // --- SLUTT ENDRING ---
    }

    function createStatsLine(label, games, data, totalGames, isHeader = false) {
        const line = document.createElement('div');
        line.className = 'move-stats-line';

        const percentage = totalGames > 0 ? ((games / totalGames) * 100).toFixed(0) : 0;
        const labelText = isHeader ? `<strong>${label}</strong>` : `<span class="move-san">${label}</span> <span style="color:var(--muted);">${percentage}%</span>`;

        const totalResults = data.white + data.draws + data.black;
        const whitePct = totalResults > 0 ? (data.white / totalResults * 100) : 0;
        const drawPct = totalResults > 0 ? (data.draws / totalResults * 100) : 0;
        const blackPct = 100 - whitePct - drawPct;

        line.innerHTML = `
            <div>${labelText}</div>
            <div class="stats-bar-container">
                <div class="stats-bar-segment stats-bar-white" style="width: ${whitePct}%;" title="Hvit vinner">${whitePct.toFixed(0)}%</div>
                <div class="stats-bar-segment stats-bar-draw" style="width: ${drawPct}%;" title="Remis">${drawPct.toFixed(0)}%</div>
                <div class="stats-bar-segment stats-bar-black" style="width: ${blackPct}%;" title="Svart vinner">${blackPct.toFixed(0)}%</div>
            </div>
        `;
        return line;
    }

    async function getAIOpeningMoveExplanation(bookData, theoryData) {
      try {
        const lastMove = game.history({ verbose: true })[idx - 1]?.san || "Startposisjon";
        const openingName = bookData.opening?.name || "Ukjent åpning";

        let statsText = '';
        if (bookData.moves && bookData.moves.length > 0) {
          const totalGames = bookData.moves.reduce((sum, m) => sum + (m.total || 0), 0);
          const top = bookData.moves[0];
          const pop = totalGames > 0 ? Math.round((top.total || 0) * 100 / totalGames) : 0;
          statsText = `Mest populære svar er ${top.san} (${pop}% av partiene).`;
        }

        const wikibooksText = theoryData?.translatedExtract || "";
        const dbSourceName = selectedOpeningDb === 'lichess'
          ? 'Lichess-databasen (alle spillere)'
          : 'Mester-databasen (tittelspillere)';

        // Bruk prompt fra eksterne filen
        const prompt = SJAKKARO_PROMPTS.openingMoveExplanation(elevRating, dbSourceName, lastMove, openingName, statsText, wikibooksText);

        return await getAICompletion(prompt);
      } catch (e) {
        console.error('AI opening explanation error:', e);
        return "Kunne ikke laste forklaring for dette trekket.";
      }
    }

    // Konverter SAN moves til UCI format for Opening Book API
    function sanToUciMoves(sanMoves, maxMoves = -1) {
      const chess = new Chess();
      const uciMoves = [];

      const movesToProcess = maxMoves > 0 ? sanMoves.slice(0, maxMoves) : sanMoves;

      for (const san of movesToProcess) {
        const move = chess.move(san);
        if (!move) break;
        uciMoves.push(move.from + move.to + (move.promotion || ''));
      }

      return uciMoves;
    }

    function buildFenFromMoves(moves) {
      const chess = new Chess();
      for (const uci of moves) {
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.slice(4) || undefined;
        chess.move({from, to, promotion});
      }
      return chess.fen();
    }

    // Hybrid evaluering: PGN > Opening Book > Stockfish
    async function getHybridEvaluation(positionIndex, uciMoves, pgnEvals) {
      // 1. Sjekk først PGN-evalueringer (raskest og mest pålitelig)
      if (pgnEvals && pgnEvals[positionIndex]) {
        return {
          source: 'PGN',
          evaluation: pgnEvals[positionIndex],
          opening: null,
          stats: null
        };
      }

      // 2. Prøv åpningsbok for tidlige trekk
      if (OPENING_BOOK.enabled && positionIndex <= OPENING_BOOK.maxPlies) {
        try {
          const fen = buildFenFromMoves(uciMoves);
          const bookData = await queryLichessOpeningBook(fen);

          if (bookData) {
            console.log('Opening book data found:', bookData);
            const evaluation = calculateOpeningEvaluation(bookData);
            console.log('Calculated evaluation:', evaluation);
            console.log('Opening info from API:', bookData.opening);
            if (evaluation !== null) {
              return {
                source: 'Opening',
                evaluation: evaluation,
                opening: bookData.opening || { name: 'Unknown Opening' },
                eco: bookData.opening?.eco,
                stats: {
                  totalGames: bookData.moves.reduce((sum, m) => sum + m.total, 0),
                  topMoves: bookData.moves.slice(0, 3).map(m => ({
                    san: m.san,
                    total: m.total,
                    performance: (m.performance * 100).toFixed(1)
                  }))
                }
              };
            }
          }
        } catch (error) {
          console.warn('Opening book query failed:', error);
        }
      }

      // 3. Fall tilbake til Stockfish
      const prefs = getEnginePrefs();
      const stockfishResult = await analyzePositionWithMoves(uciMoves, prefs);
      let score = stockfishResult?.score ?? '0.00';

      // Juster perspektiv til Lichess-standard (alltid fra hvits perspektiv)
      if(/^(-?\d+(?:\.\d+)?)$/.test(String(score))) {
        let num = parseFloat(score);
        const isBlackToMove = (positionIndex % 2 === 1);
        if(isBlackToMove) {
          num = -num; // Inverter evalueringen for svarts trekk
        }
        score = num >= 0 ? '+' + num.toFixed(2) : num.toFixed(2);
      }

      return {
        source: 'Stockfish',
        evaluation: score,
        opening: null,
        stats: null
      };
    }

    function updatePlayerInfoPanel(gameData) {
      const panel = document.getElementById('playerInfoPanel');
      if (!gameData) { panel.style.display = 'none'; return; }

      document.getElementById('whitePlayerName').textContent   = gameData.white || 'Hvit';
      document.getElementById('whitePlayerRating').textContent = gameData.whiteElo ? `(${gameData.whiteElo})` : '';
      const wDiff = document.getElementById('whitePlayerRatingDiff');
      if (gameData.whiteRatingDiff != null && gameData.whiteRatingDiff !== '') {
        const d = parseInt(gameData.whiteRatingDiff, 10);
        wDiff.textContent = `(${d >= 0 ? '+' : ''}${d})`;
        wDiff.className = 'player-rating-diff ' + (d >= 0 ? 'positive' : 'negative');
      } else { wDiff.textContent = ''; wDiff.className = 'player-rating-diff'; }

      document.getElementById('blackPlayerName').textContent   = gameData.black || 'Svart';
      document.getElementById('blackPlayerRating').textContent = gameData.blackElo ? `(${gameData.blackElo})` : '';
      const bDiff = document.getElementById('blackPlayerRatingDiff');
      if (gameData.blackRatingDiff != null && gameData.blackRatingDiff !== '') {
        const d = parseInt(gameData.blackRatingDiff, 10);
        bDiff.textContent = `(${d >= 0 ? '+' : ''}${d})`;
        bDiff.className = 'player-rating-diff ' + (d >= 0 ? 'positive' : 'negative');
      } else { bDiff.textContent = ''; bDiff.className = 'player-rating-diff'; }

      panel.style.display = 'block';
    }

    function updateGameMetaInfo(gameData) {
      const metaEl = document.getElementById('gameMetaInfo');
      metaEl.innerHTML = '';
      if (!gameData) return;
      const parts = [];
      if (gameData.timeControl) parts.push(`<span>Tid: ${gameData.timeControl}</span>`);
      if (gameData.result)      parts.push(`<span>Res: ${gameData.result}</span>`);
      metaEl.innerHTML = parts.join('');
    }

    function init(){
      document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',onTab));
      document.getElementById('btnPrev').addEventListener('click',prevMove);
      document.getElementById('btnNext').addEventListener('click',nextMove);
      document.getElementById('btnStart').addEventListener('click',resetPosition);
      document.getElementById('btnEnd').addEventListener('click',goToEnd);
      document.getElementById('btnDkart').addEventListener('click',toggleDkart);
      document.getElementById('btnPositionAnalysis').addEventListener('click', handlePositionAnalysis);
      document.getElementById('btnAnalyze').addEventListener('click',openLichessAnalysis);
      document.getElementById('btnPGN').addEventListener('click',openPGNModal);
      document.getElementById('closeModal').addEventListener('click',closePGNModal);
      document.getElementById('cancelBtn').addEventListener('click',closePGNModal);
      document.getElementById('configBtn').addEventListener('click',openConfigModal);
      document.getElementById('closeConfigModal').addEventListener('click',closeConfigModal);
      document.getElementById('saveConfigBtn').addEventListener('click',saveConfig);
      document.getElementById('resetConfigBtn').addEventListener('click',resetConfig);
      document.getElementById('fetchLichessBtn').addEventListener('click',fetchLichessGames);
      document.getElementById('loadFileBtn').addEventListener('click',()=>document.getElementById('pgnFile').click());
      document.getElementById('pgnFile').addEventListener('change',handleFileInput);
      document.getElementById('selectGameBtn').addEventListener('click',selectGameFromFile);
      document.getElementById('loadTextBtn').addEventListener('click',loadFromText);

      // Chat event listeners
      document.getElementById('chatSendBtn').addEventListener('click', handleChatMessage);
      document.getElementById('chatInput').addEventListener('keypress', (e) => {
          if (e.key === 'Enter') {
              handleChatMessage();
          }
      });

      // Add opening book configuration listeners
      document.getElementById('openingEnabled')?.addEventListener('change', updateOpeningBookConfig);
      document.getElementById('openingStrategy')?.addEventListener('change', updateOpeningBookConfig);
      document.getElementById('minGamesInput')?.addEventListener('input', updateOpeningBookConfig);
      document.getElementById('maxPliesInput')?.addEventListener('input', updateOpeningBookConfig);

      // Add weight matrix editor listeners
      document.getElementById('weightPresetSelector')?.addEventListener('change', onWeightPresetChange);
      initializeWeightMatrix();

      // Les aktiv modell før vi fyller UI
      currentAIModel = localStorage.getItem('aiModel') ?? 'gemini-2.5-flash-lite';

      // Migrer gamle modell-nøkler til nye ID-baserte nøkler
      if (currentAIModel === 'gemini-flash-lite') {
        setCurrentAIModel('gemini-2.5-flash-lite');
        currentAIModel = 'gemini-2.5-flash-lite';
        console.log('Migrated from old Gemini key to model-ID based key');
      }
      if (currentAIModel === 'groq-llama3-8b' || currentAIModel === 'groq-deepseek-r1') {
        setCurrentAIModel('deepseek-r1-distill-llama-70b');
        currentAIModel = 'deepseek-r1-distill-llama-70b';
        console.log('Migrated from old Groq key to model-ID based key');
      }

      // Migrer gammel hardkodet nøkkel til localStorage (hvis den ikke allerede finnes)
      if (!getGeminiApiKey() && typeof GEMINI_API_KEY !== 'undefined' && GEMINI_API_KEY) {
        setGeminiApiKey('AIzaSyBhT--1GglCIdvAN_zq7NzFuwcd9bWFfrA');
      }

      // Fyll AI UI
      populateAIModelSelector();
      loadAIKeyInputs();

      const panelToggle=document.getElementById('panelToggle');
      const sidepanel=document.getElementById('sidepanel');
      const overlay=document.getElementById('overlay');
      panelToggle.addEventListener('click',()=>{sidepanel.classList.toggle('open');overlay.classList.toggle('show');panelToggle.setAttribute('aria-expanded',sidepanel.classList.contains('open'))});
      overlay.addEventListener('click',()=>{sidepanel.classList.remove('open');overlay.classList.remove('show');panelToggle.setAttribute('aria-expanded','false')});

      window.addEventListener('keydown',(e)=>{
        if(!e.key) return;
        if(e.key==='ArrowRight'){ nextMove(); }
        else if(e.key==='ArrowLeft'){ prevMove(); }
        else if(e.key==='ArrowUp'){ e.preventDefault(); /* autoplay fjernet */ }
        else if(e.key==='ArrowDown'){ resetPosition(); }
        else if(e.key==='CapsLock'){ toggleDkart(); }
      });

      const cfg={
        position:'start',
        draggable:true,
        showNotation:true,
        pieceTheme:'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/alpha/{piece}.svg',
        onDrop: handlePieceDrop
      };
      if(window.Chessboard){board=Chessboard('board',cfg);} else if(window.ChessBoard){board=ChessBoard('board',cfg);} else if(window.jQuery&&$.fn&&$.fn.chessboard){board=$('#board').chessboard(cfg);} else {throw new Error('Chessboard library not found.');}

      loadCategory('opening');
      tryStartEngine();
      window.addEventListener('resize',()=>{board.resize(); if(dkOn) drawDkart();});

      // Load puzzle data on startup
      loadPuzzleData();

      // Initialize weight matrix configuration
      updateActiveWeightMatrix();
    }

    /********************* Modal utils *********************/
    function openPGNModal(){document.getElementById('pgnModal').classList.add('show');clearInputs();clearMessages();}
    function closePGNModal(){document.getElementById('pgnModal').classList.remove('show');clearMessages();clearInputs();}

    function openConfigModal(){
      populateAIModelSelector();
      loadAIKeyInputs();
      // Forhåndsfyll elevRating
      const er = document.getElementById('elevRatingInput');
      if (er) er.value = elevRating;
      // Initialize weight matrix editor
      initializeWeightMatrix(); // Sikre at matrisen er generert
      loadWeightMatrixEditor();
      document.getElementById('configModal').classList.add('show');
    }
    function closeConfigModal(){document.getElementById('configModal').classList.remove('show');}

    function saveConfig(){
      updateOpeningBookConfig();
      // Lagre AI-nøkler og modell
      saveAISettingsFromModal();
      // Lagre elevRating
      const er = document.getElementById('elevRatingInput');
      if (er) setElevRating(er.value);
      // Lagre weight matrix konfigurasjon
      saveWeightMatrixConfig();
      closeConfigModal();
      console.log('Configuration saved');
    }

    function resetConfig(){
      // Reset to default values
      document.querySelector('input[name="mode"][value="movetime"]').checked = true;
      document.getElementById('mtInput').value = 1500;
      document.getElementById('depthInput').value = 18;
      document.getElementById('mpvInput').value = 3;
      document.getElementById('openingEnabled').checked = true;
      document.getElementById('openingStrategy').value = 'balanced';
      document.getElementById('minGamesInput').value = 100;
      document.getElementById('maxPliesInput').value = 20;

      // Reset AI settings
      setCurrentAIModel('gemini-2.5-flash-lite');
      document.getElementById('geminiApiKeyInput').value = '';
      document.getElementById('groqApiKeyInput').value = '';
      populateAIModelSelector();

      // Reset weight matrix to defaults
      resetWeightMatrixToDefault();

      updateOpeningBookConfig();
      console.log('Configuration reset to defaults');
    }
    function clearMessages(){document.getElementById('errorMessage').style.display='none';document.getElementById('loadingMessage').style.display='none'}
    function showError(msg){const el=document.getElementById('errorMessage');el.textContent=msg;el.style.display='block';document.getElementById('loadingMessage').style.display='none'}
    function showLoading(msg){const el=document.getElementById('loadingMessage');el.innerHTML=`<span class="spinner"></span>${msg}`;el.style.display='block';document.getElementById('errorMessage').style.display='none'}
    function hideMessages(){clearMessages()}
    function clearInputs(){document.getElementById('lichessUsername').value='';document.getElementById('pgnText').value='';const fi=document.getElementById('pgnFile');if(fi) fi.value='';const sect=document.getElementById('gameSelectSection');if(sect) sect.style.display='none';const sel=document.getElementById('gameSelect');if(sel) sel.innerHTML='';fileGameList=[]}

    async function fetchLichessGames(){
      const username=document.getElementById('lichessUsername').value.trim().replace('@','');
      const numGames=parseInt(document.getElementById('numGames').value)||1;
      if(!username){showError('Vennligst skriv inn et Lichess‑brukernavn.');return}
      showLoading('Henter partier fra Lichess...');
      try{
        // 1) prøv lokal server hvis du kjører en proxy/back‑end
        const resp = await fetch(`${SERVER_URL}/fetch_lichess_games`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username, max_games:numGames})});
        if(resp.ok){const data=await resp.json(); if(data.games?.length){await loadGameData(data.games[0]); closePGNModal(); return;} else {showError('Ingen partier funnet.'); return;}}
        // hvis ikke ok, faller vi til direkte‑hent
        throw new Error('Local server not available');
      }catch(_){
        // 2) Direktehenting fra Lichess API (PGN som tekst). CORS er tillatt av Lichess.
        try{
          // NB: application/x-chess-pgn returnerer flere partier i rekkefølge
          const url=`https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${numGames}&moves=true`;
          const r = await fetch(url,{headers:{'Accept':'application/x-chess-pgn'}});
          if(!r.ok){throw new Error(`Lichess svarte ${r.status}`)}
          const text = await r.text();
          // splitt på [Event]
          const chunks = text.replace(/\r\n/g,'\n').trim().split(/\n\n(?=\[Event)/g).filter(s=>s.trim().length>0);
          if(!chunks.length){throw new Error('Fant ingen partier i svaret')}
          await loadGameFromPGN(chunks[0]);
          closePGNModal();
        }catch(e){console.error('Lichess fetch error:', e); showError('Kunne ikke hente partier fra Lichess (ingen lokal server, og direktekall feilet).');}
      }
    }

    async function loadFromText(){
      const pgnText=document.getElementById('pgnText').value.trim();
      if(!pgnText){showError('PGN-data kan ikke være tom.');return}
      showLoading('Behandler PGN...');
      try{await loadGameFromPGN(pgnText);closePGNModal();}catch(e){console.error('Text load error:',e);showError('Kunne ikke tolke PGN-data. Sjekk format.');}
    }

    async function handleFileInput(ev){
      const file=ev.target.files&&ev.target.files[0];
      if(!file){showError('Vennligst velg en PGN‑fil.');return}
      showLoading('Laster fil...');
      try{
        const text=await file.text();
        if(!text || typeof text !== 'string'){
          throw new Error('Invalid file content');
        }
        const normalized=text.replace(/\r\n/g,'\n');
        const chunks=normalized.trim().split(/\n\n(?=\[Event)/g).filter(x=>x.trim().length>0);
        if(chunks.length<=1){
          await loadGameFromPGN(chunks[0]||normalized);
          closePGNModal();
        }
        else{
          fileGameList=chunks;
          const select=document.getElementById('gameSelect');
          select.innerHTML='';
          chunks.forEach((pgn,i)=>{
            let label=`Parti ${i+1}`;
            try{
              const header={};
              const re=/\[(\w+)\s+"([^"]*)"\]/g;
              let m;
              while((m=re.exec(pgn))) header[m[1]]=m[2];
              const w=header.White||'Ukjent';
              const b=header.Black||'Ukjent';
              const d=header.Date||'';
              label=`${i+1}: ${w} vs ${b}${d?` (${d})`:''}`;
            }catch(e){console.error('Header parsing error:',e);}
            const opt=document.createElement('option');
            opt.value=String(i);
            opt.textContent=label;
            select.appendChild(opt);
          });
          document.getElementById('gameSelectSection').style.display='block';
          hideMessages();
        }
      }catch(e){
        console.error('File load error:',e);
        showError('Kunne ikke laste PGN‑fil.');
      }
    }

    async function selectGameFromFile(){
      try{const sel=document.getElementById('gameSelect');const k=parseInt(sel.value,10);if(isNaN(k)||!fileGameList[k]){showError('Ugyldig partisvalg.');return}
        await loadGameFromPGN(fileGameList[k]); fileGameList=[]; document.getElementById('gameSelect').innerHTML=''; document.getElementById('gameSelectSection').style.display='none'; closePGNModal();
      }catch(e){console.error('Select game error:',e);showError('Kunne ikke laste valgt parti.');}
    }

    async function loadGameFromPGN(pgnText){
      if(!pgnText || typeof pgnText !== 'string'){
        throw new Error('Invalid PGN text');
      }
      const normalized=pgnText.replace(/\r\n/g,'\n');
      const chunks=normalized.trim().split(/\n\n(?=\[Event)/g);
      const pgn=(chunks[0]||normalized).trim();
      const chess=new Chess();
      if(!chess.load_pgn(pgn,{sloppy:true})) throw new Error('Ugyldig PGN');
      const header=chess.header();
      const gameData={
        id:header.Site?.split('/').pop()||`manual-${Date.now()}`,
        pgn
      };
      await loadGameData(gameData);
    }

    async function loadGameData(gameData){
      selectedOpeningDb = 'lichess';
      // Tilbakestill alle data for nytt parti
      timeSpentList = [];
      document.getElementById('chatHistory').innerHTML = '';
      document.getElementById('chatPanel').style.display = 'none';
      chatHistory = [];

      openingTextCache.clear();
      loadedGame = gameData;

      game = new Chess();
      game.load_pgn(gameData.pgn,{sloppy:true});
      const header = game.header();

      // Utvid hodeinfo
      loadedGame.white = header.White || 'Ukjent';
      loadedGame.black = header.Black || 'Ukjent';
      loadedGame.result = header.Result || '*';
      loadedGame.whiteElo = header.WhiteElo;
      loadedGame.blackElo = header.BlackElo;
      loadedGame.whiteRatingDiff = header.WhiteRatingDiff;
      loadedGame.blackRatingDiff = header.BlackRatingDiff;
      loadedGame.timeControl = header.TimeControl;

      const history=game.history();
      game.reset();
      sanList=history; idx=0;

      // Beregn tidsbruk per trekk
      timeSpentList = extractAndCalculateTimeSpent(gameData.pgn, sanList.length);

      // Parse avanserte PGN-annotasjoner
      pgnAnnotations = parseAdvancedPGNAnnotations(gameData.pgn);

      board.position('start');

      // Tittel skal være statisk – navn vises i spillerpanelet
      document.getElementById('boardTitle').textContent = 'Partianalyse';
      updatePlayerInfoPanel(loadedGame);
      updateGameMetaInfo(loadedGame);

      renderMoveList();
      updateButtons();

      // Parse opening info from PGN headers (works for all game loading paths)
      gameOpeningInfo = null;
      if (gameData.pgn) {
        console.log('🔍 Parsing opening from PGN headers...');
        const ecoMatch = gameData.pgn.match(/\[ECO\s+"([^"]*)"\]/);
        const openingMatch = gameData.pgn.match(/\[Opening\s+"([^"]*)"\]/);
        console.log('ECO match:', ecoMatch);
        console.log('Opening match:', openingMatch);
        if (ecoMatch && openingMatch) {
          gameOpeningInfo = {
            name: openingMatch[1],
            eco: ecoMatch[1],
            totalGames: 0,
            source: 'PGN'
          };
          console.log('✅ Opening info from PGN headers:', gameOpeningInfo);
        } else {
          console.log('❌ No opening info found in PGN headers');
        }
      }

      // Sjekk om PGN allerede inneholder evalueringer
      if (hasEvaluations(gameData.pgn)) {
        console.log('PGN contains evaluations - using existing evals instead of Stockfish');
        showLoading('Bruker eksisterende evalueringer fra PGN...');

        try {
          // Ekstraher evalueringer fra PGN
          const extractedEvals = extractEvaluationsFromPGN(gameData.pgn);
          evaluations = alignEvaluationsWithMoves(extractedEvals, sanList.length);

          // Initialize enhancedEvals for PGN path
          enhancedEvals = evaluations.map(eval => ({
            source: 'PGN',
            evaluation: eval,
            opening: null,
            stats: null
          }));
          console.log('Initialized enhancedEvals for PGN path:', enhancedEvals.length);

          // Oppdater UI og gå direkte til AI-analyse
          renderMoveList();
          hideMessages();

          // Vis evalueringskilde i UI
          showEvaluationSource('PGN');

          console.log('Using PGN evaluations:', evaluations);
          await analyzeGame();

          // Update opening information panel after loading game with PGN evaluations
          console.log('🎯 After PGN eval loading - calling updateDynamicOpeningInfo');
          updateDynamicOpeningInfo();
        } catch (error) {
          console.error('Error processing PGN evaluations:', error);
          showError('Feil ved behandling av PGN-evalueringer. Faller tilbake til Stockfish...');
          // Fallback til normal Stockfish-evaluering
          await evaluateGamePositions();
        }
      } else {
        console.log('PGN has no evaluations - running Stockfish analysis');
        // Normal arbeidsflyt med Stockfish
        await evaluateGamePositions();
      }
    }

    /********************* Stockfish *********************/
    function tryStartEngine(){
      try{
        console.log('Starting Stockfish engine...');
        engine=new Worker('stockfish.js');
        engine.onmessage=(e)=>handleEngineMsg(String(e.data));
        engine.onerror=(e)=>{console.error('Stockfish worker error:', e);};
        engine.postMessage('uci');
        console.log('UCI command sent');
      }
      catch(e){
        console.error('Fant ikke stockfish.js i mappen.',e);
        alert('Legg stockfish.js (WASM build) i samme mappe som index.html.');
      }
    }

    function handleEngineMsg(msg){
      console.log('Stockfish:', msg); // Debug log

      if(msg==="uciok"){ // sett opsjoner når UCI er etablert
        console.log('Setting engine options...');
        const { mpv } = getEnginePrefs();

        // Kun sett opsjoner som denne motoren støtter
        engine.postMessage(`setoption name MultiPV value ${mpv}`);

        // Sjekk at Hash ikke er låst til 16 (som i console output)
        if(engineCaps.options.Hash && engineCaps.options.Hash.max > 16) {
          engine.postMessage('setoption name Hash value 64');
        }

        if(engineCaps.threads && engineCaps.options.Threads && engineCaps.options.Threads.max > 1){
          engine.postMessage('setoption name Threads value '+Math.min(2, engineCaps.options.Threads.max));
        }

        console.log('Sending isready...');
        engine.postMessage('isready');
        return;
      }
      if(msg.startsWith('option name ')){
        // parse opsjoner for å oppdage Threads mv.
        // eksempel: option name Threads type spin default 1 min 1 max 1024
        const m = msg.match(/^option name (\S+) type (\S+)(.*)$/);
        if(m){
          const name=m[1]; const type=m[2]; const rest=m[3]||''; const opt={type};
          const d=rest.match(/default\s+([\S]+)/); if(d) opt.default=d[1];
          const min=rest.match(/min\s+(\d+)/); const max=rest.match(/max\s+(\d+)/);
          if(min) opt.min=parseInt(min[1],10); if(max) opt.max=parseInt(max[1],10);
          engineCaps.options[name]=opt; if(name==='Threads') engineCaps.threads=true;
        }
        return;
      }
      if(msg==='readyok'){ console.log('✅ Stockfish klar'); return; }
      if(msg.startsWith('info')){
        const mMate=msg.match(/score mate (-?\d+)/); const mCp=msg.match(/score cp (-?\d+)/); const mD=msg.match(/ depth (\d+)/); const pvM=msg.match(/ pv (.+)/);
        if(mMate){
          const n=parseInt(mMate[1],10);
          // Konverter til Lichess-format (#X for mate)
          lastInfo.score = n>=0 ? `#${n}` : `#${Math.abs(n)}`;
        }
        if(mCp){
          let score = parseInt(mCp[1],10) / 100;
          // Ingen perspektiv-justering her - det gjøres i evaluateGamePositions basert på posisjon-indeks
          lastInfo.score = score.toFixed(2);
        }
        if(mD){ lastInfo.depth=parseInt(mD[1],10); }
        if(pvM){ lastInfo.pv=pvM[1]; }
        return;
      }
      if(msg.startsWith('bestmove')){
        console.log('Bestmove received:', msg); // Debug log
        if(analysisResolver){
          const r=analysisResolver;
          analysisResolver=null;
          r(lastInfo);
        }
        return;
      }
    }

    function uciPositionFromMoves(moves){ return `position startpos${moves?.length?(' moves '+moves.join(' ')):' '}`; }

    function analyzePositionWithMoves(moves, prefs){
      return new Promise((resolve, reject)=>{
        lastInfo={score:null,depth:null,pv:null};
        let settled=false;

        const cleanup=()=>{ analysisResolver=null; };

        const hardTimeout=setTimeout(()=>{
          if(!settled){
            settled=true;
            console.log('Analysis timeout - stopping engine');
            try{engine.postMessage('stop')}catch(e){console.log('Stop error:', e)}
            cleanup();
            reject(new Error('Analysis timeout'));
          }
        }, 10000); // 10 seconds

        analysisResolver=(final)=>{
          if(settled) return;
          settled=true;
          clearTimeout(hardTimeout);
          cleanup();
          console.log('Analysis completed:', final);
          resolve(final);
        };

        try{
          console.log('Starting analysis for moves:', moves);

          // Simplified command sequence
          engine.postMessage('stop');

          setTimeout(() => {
            if(settled) return;

            const posCmd = uciPositionFromMoves(moves);
            console.log('Sending position:', posCmd);
            engine.postMessage(posCmd);

            // Bruk alltid movetime for bedre kompatibilitet
            const moveTime = prefs.mode === 'movetime' ? prefs.ms : 1000;
            const goCmd = `go movetime ${moveTime}`;
            console.log('Sending go command:', goCmd);
            engine.postMessage(goCmd);
          }, 100);
        }catch(err){
          if(!settled) {
            settled=true;
            clearTimeout(hardTimeout);
            cleanup();
            reject(err);
          }
        }
      });
    }

    // === MVP: Manuell posisjonsanalyse basert på én bestmove (simulert MultiPV) ===
    async function handlePositionAnalysis() {
      const btn = document.getElementById('btnPositionAnalysis');
      const aiTextEl = document.getElementById('aiOpeningText');
      const statsContainer = document.getElementById('openingStatsContainer');
      const openingNameEl = document.getElementById('openingName');

      if (!game) return;

      btn.disabled = true;
      openingNameEl.textContent = 'Posisjonsanalyse';
      aiTextEl.innerHTML = `<span class="spinner"></span> Analyserer med Stockfish...`;
      statsContainer.innerHTML = '';

      try {
        const uciMoves = game.history({ verbose: true }).slice(0, idx).map(m => m.from + m.to + (m.promotion || ''));
        // Kjør motoren én gang – MVP
        const analysisResult = await analyzePositionWithMoves(uciMoves, { mode: 'movetime', ms: 1500, depth: 21, mpv: 1 });

        // Simulér MultiPV-tekst (kan byttes ut senere når MultiPV-parsing er på plass)
        const stockfishEval = `1. ${analysisResult?.pv || 'N/A'} (Eval: ${analysisResult?.score ?? 'N/A'})`;

        updateStockfishStatsUI(analysisResult);

        aiTextEl.innerHTML = `<span class="spinner"></span> Genererer AI-analyse...`;

        // Bruk prompt fra eksterne filen
        const prompt = SJAKKARO_PROMPTS.positionAnalysis(game.fen(), elevRating, stockfishEval, pgnAnnotations, idx);

        const aiAnalysis = await getAICompletion(prompt);
        aiTextEl.textContent = aiAnalysis || 'Ingen analyse tilgjengelig.';
      } catch (e) {
        console.error('Posisjonsanalyse feilet:', e);
        aiTextEl.textContent = 'En feil oppstod under analysen.';
      } finally {
        // Forblir deaktivert til nytt trekk – styres i updateDynamicOpeningInfo() og ved navigasjon
      }
    }

    function updateStockfishStatsUI(stockfishResult) {
      const container = document.getElementById('openingStatsContainer');
      container.innerHTML = '';

      if (!stockfishResult || !stockfishResult.pv) {
        container.innerHTML = '<p style="font-size:12px; color:var(--muted);">Ingen Stockfish-data.</p>';
        return;
      }

      const line = document.createElement('div');
      line.className = 'move-stats-line';
      line.innerHTML = `
        <div><span class="move-san">Beste linje</span></div>
        <div>${stockfishResult.pv} &nbsp; <span style="color:var(--muted)">(${stockfishResult.score ?? '—'})</span></div>
      `;
      container.appendChild(line);
    }

    async function evaluateGamePositions(){
      if(!loadedGame || sanList.length===0) return;
      if(!engine) tryStartEngine();

      // Vent litt på at engine skal bli klar
      console.log('Waiting for engine to be ready...');
      await new Promise(resolve => setTimeout(resolve, 2000));

      updateOpeningBookConfig(); // Oppdater konfigurasjon før evaluering
      showLoading('Evaluerer stillinger med hybrid-tilnærming...');

      // bygg alle posisjoner som UCI‑trekksekvenser
      const temp=new Chess(); const positions=[[]]; // startpos
      for(const m of sanList){
        const mo=temp.move(m);
        if(!mo){console.warn('Ugyldig trekk i history',m); break;}
        positions.push([...(positions[positions.length-1]), mo.from+mo.to+(mo.promotion||'')]);
      }

      evaluations=[];
      enhancedEvals=[];
      let sourceStats = { PGN: 0, Opening: 0, Stockfish: 0 };

      // gameOpeningInfo should already be set from loadGameData()
      console.log('🔍 Starting evaluateGamePositions with gameOpeningInfo:', gameOpeningInfo);

      for(let i=0;i<positions.length;i++){
        try{
          const result = await getHybridEvaluation(i, positions[i], null);

          evaluations.push(result.evaluation);
          enhancedEvals.push(result);
          sourceStats[result.source]++;

          // Update opening info with Lichess data when available
          if (result.source === 'Opening' && result.opening && result.opening.name) {
            gameOpeningInfo = {
              name: result.opening.name,
              eco: result.opening.eco || result.eco || gameOpeningInfo?.eco,
              totalGames: result.stats?.totalGames || 0,
              source: 'Lichess'
            };
            console.log('gameOpeningInfo updated with Lichess data:', gameOpeningInfo);
          }

          const phase = result.source === 'Opening' ? 'Åpningsbok' :
                       result.source === 'PGN' ? 'PGN-data' : 'Stockfish';
          console.log(`Position ${i}: ${result.evaluation} (${phase})`);

        }catch(e){
          console.warn('Pos',i,'feilet:',e.message);
          const fb=evaluations.length? evaluations[evaluations.length-1] : '0.00';
          evaluations.push(fb);
          enhancedEvals.push({source: 'Error', evaluation: fb, opening: null, stats: null});
        }
        const p=Math.round((i+1)/positions.length*100);
        showLoading(`Evaluerer stillinger (hybrid)... ${p}%`);
      }

      // Vis evalueringskilde basert på hvilken som ble brukt mest
      const primarySource = Object.keys(sourceStats).reduce((a, b) => sourceStats[a] > sourceStats[b] ? a : b);
      if (sourceStats.Opening > 0 && sourceStats.Stockfish > 0) {
        showEvaluationSource('Hybrid');
      } else {
        showEvaluationSource(primarySource);
      }

      console.log('Evaluation sources used:', sourceStats);
      if (gameOpeningInfo) {
        console.log('Opening detected:', gameOpeningInfo);
      }

      renderMoveList();
      hideMessages();
      await analyzeGame();

      // Update opening information panel
      console.log('🎯 About to call updateDynamicOpeningInfo');
      updateDynamicOpeningInfo();
    }

    /********************* AI‑analyse + autoscroll‑fix *********************/
    function mdToHtml(md){
      // Minimal konvertering for overskrifter og fet tekst slik at autoscroll kan finne <h3>
      let html=md.replace(/^###\s+(.+)$/gm,'<h3>$1</h3>');
      html=html.replace(/^##\s+(.+)$/gm,'<h2>$1</h2>');
      html=html.replace(/^#\s+(.+)$/gm,'<h1>$1</h1>');
      html=html.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');
      html=html.replace(/\n\n/g,'\n'); // litt kompakt
      html=html.replace(/\n/g,'<br/>');
      return html;
    }

    async function analyzeGame(){
      if(!loadedGame) return; showLoading('Analyserer parti med AI...');
      try{
        // inkluder evals i prompt med trekk-detaljer og åpningskontext
        let evalSummary='';
        let moveDetails='';
        let openingContext='';

        // Åpningsinformasjon
        if(gameOpeningInfo) {
          openingContext = `\n\nÅPNINGSINFORMASJON:\n`;
          openingContext += `- Åpning: ${gameOpeningInfo.eco ? gameOpeningInfo.eco + ' - ' : ''}${gameOpeningInfo.name}\n`;
          openingContext += `- Basert på ${gameOpeningInfo.totalGames.toLocaleString()} Lichess-partier\n`;

          // Finn åpningsbok-evalueringer og legg til kontext
          const openingEvals = enhancedEvals.filter(e => e && e.source === 'Opening').slice(0, 5);
          if(openingEvals.length > 0) {
            openingContext += `- Teoretisk vurdering av de første ${openingEvals.length} trekkene\n`;
            openingContext += `- Sammenlign spillerens valg med mesterspill-statistikk\n`;
          }
        }

        if(evaluations.length){
          evalSummary='\n\nEVALUERINGER for hver posisjon (0=start):\n';
          moveDetails='\n\nTrekK-DETALJER for referanse:\n';

          for(let i=0;i<Math.min(evaluations.length,sanList.length+1);i++){
            const mv=i===0?'start':sanList[i-1]||'?';
            const source = enhancedEvals[i] ? enhancedEvals[i].source : 'Unknown';
            const sourceLabel = source === 'Opening' ? '(Åpningsbok)' :
                               source === 'PGN' ? '(PGN)' :
                               source === 'Stockfish' ? '(Stockfish)' : '';

            evalSummary+=`#${i} ${mv}: ${evaluations[i]||'0.00'} ${sourceLabel}\n`;

            if(i>0){
              const moveNum = Math.ceil(i / 2);
              const color = (i % 2 === 1) ? 'Hvit' : 'Svart';
              moveDetails+=`Trekk ${moveNum}. ${color}: ${mv}\n`;
            }
          }
        }
        // Forbered listen med gyldige temaer for prompten
        const validThemes = SJAKKARO_CONFIG.puzzles.validThemes;
        const validThemesString = validThemes.join(', ');

        // Bruk prompt fra eksterne filen
        const prompt = SJAKKARO_PROMPTS.gameAnalysis(gameOpeningInfo, validThemesString, loadedGame.pgn, openingContext, evalSummary, moveDetails, pgnAnnotations);
        let md = await getAICompletion(prompt) || 'Ingen analyse.';

        // Search for [PUZZLE_THEME: ...] tags and replace with buttons
        md = md.replace(/\[PUZZLE_THEME:\s*(\w+)\]/g, (match, theme) => {
          console.log('Found puzzle theme:', theme);
          return `<button class="btn btn--primary" onclick="startPuzzleSequence('${theme}')">🧩 Start øvelse</button>`;
        });

        const html=mdToHtml(md);
        const box=document.getElementById('explainBox'); box.innerHTML = `<h3>AI‑analyse</h3><div class="ai" style="line-height:1.6;">${html}</div>`;
        hideMessages();
        document.getElementById('chatPanel').style.display = 'block';

        // Update opening information panel after AI analysis is complete
        console.log('🎯 After AI analysis - calling updateDynamicOpeningInfo');
        updateDynamicOpeningInfo();
      }catch(e){ console.error('Analysis error:',e); showError('Kunne ikke analysere partiet med AI. Sett gyldig API‑nøkkel.'); }
    }

    /********************* PUZZLE SYSTEM *********************/

    // Load puzzle data from CSV file
    async function loadPuzzleData() {
      try {
        console.log('Loading puzzle data from CSV...');
        const response = await fetch('assets/lichess_puzzles_1200.csv');
        if (!response.ok) throw new Error('Failed to load puzzle CSV');

        const csvText = await response.text();
        const lines = csvText.split('\n');
        const headers = lines[0].split(',');

        allPuzzles = [];
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          const values = line.split(',');
          if (values.length >= headers.length) {
            const puzzle = {};
            headers.forEach((header, index) => {
              puzzle[header] = values[index];
            });

            // Only include puzzles in rating range 800-1400
            const rating = parseInt(puzzle.Rating);
            if (rating >= 800 && rating <= 1400) {
              allPuzzles.push(puzzle);
            }
          }
        }

        console.log(`Loaded ${allPuzzles.length} puzzles in rating range 800-1400`);
        return true;
      } catch (error) {
        console.error('Error loading puzzle data:', error);
        return false;
      }
    }

    // Start puzzle sequence based on theme
    function startPuzzleSequence(theme) {
      console.log('Starting puzzle sequence for theme:', theme);

      if (allPuzzles.length === 0) {
        showError('Oppgavedata ikke lastet. Prøv å laste siden på nytt.');
        return;
      }

      // Find suitable puzzle for the theme
      const suitablePuzzles = allPuzzles.filter(puzzle => {
        return puzzle.Themes && puzzle.Themes.includes(theme);
      });

      if (suitablePuzzles.length === 0) {
        showError(`Ingen oppgaver funnet for tema: ${theme}`);
        return;
      }

      // Select random puzzle from suitable ones
      const randomIndex = Math.floor(Math.random() * suitablePuzzles.length);
      const selectedPuzzle = suitablePuzzles[randomIndex];

      launchPuzzle(selectedPuzzle);
    }

    // Launch a specific puzzle
    function launchPuzzle(puzzle) {
      console.log('Launching puzzle:', puzzle.PuzzleId);

      // Save current analysis state
      savedAnalysisFEN = game.fen();

      // Set puzzle mode
      isInPuzzleMode = true;
      currentPuzzle = puzzle;
      currentPuzzleStep = 0;

      // Prepare solution moves
      puzzleSolutionMoves = puzzle.Moves.split(' ');
      console.log('Puzzle solution moves:', puzzleSolutionMoves);

      // Load puzzle position
      game.load(puzzle.FEN);
      board.position(puzzle.FEN);

      // Update board title
      document.getElementById('boardTitle').textContent = `Oppgave ${puzzle.PuzzleId} (Rating: ${puzzle.Rating})`;

      // Auto-play first move (scenario setup) after 500ms
      setTimeout(() => {
        if (puzzleSolutionMoves.length > 0) {
          const firstMove = puzzleSolutionMoves[0];

          // Execute the first move
          const move = game.move({
            from: firstMove.substring(0, 2),
            to: firstMove.substring(2, 4),
            promotion: firstMove.length > 4 ? firstMove[4] : undefined
          });

          if (move) {
            board.position(game.fen());

            // Bestem spillerens farge og roter brettet om nødvendig
            const playerColor = game.turn() === 'w' ? 'white' : 'black';
            board.orientation(playerColor);

            // Highlight the move with yellow color for 2 seconds
            highlightMove(firstMove.substring(0, 2), firstMove.substring(2, 4), 'yellow', 2000);

            const playerColorName = playerColor === 'white' ? 'hvit' : 'svart';
            const instruction = translateThemeToInstruction(puzzle.Themes);
            document.getElementById('boardTitle').textContent = `Du spiller ${playerColorName}, kan du ${instruction}?`;
          }
        }
      }, 500);
    }

    // Highlight a move on the board
    function highlightMove(from, to, color = 'yellow', duration = 2000) {
      // Remove any existing highlights
      $('.square-55d63').removeClass('highlight-yellow highlight-green highlight-red');

      // Add highlight
      $(`.square-${from}`).addClass(`highlight-${color}`);
      $(`.square-${to}`).addClass(`highlight-${color}`);

      // Remove highlight after duration
      setTimeout(() => {
        $(`.square-${from}`).removeClass(`highlight-${color}`);
        $(`.square-${to}`).removeClass(`highlight-${color}`);
      }, duration);
    }

    // Complete puzzle successfully
    function completePuzzle() {
      document.getElementById('boardTitle').textContent = "Oppgave løst! Bra jobbet!";

      // Wait 2-3 seconds then exit puzzle mode
      setTimeout(() => {
        exitPuzzleMode();
      }, 2500);
    }

    // NY HJELPEFUNKSJON FOR PUZZLE-INSTRUKSJONER
    function translateThemeToInstruction(themes) {
        if (themes.includes('mateIn1')) return "finn sjakkmatt i ett trekk";
        if (themes.includes('mateIn2')) return "finn sjakkmatt i to trekk";
        if (themes.includes('mateIn3')) return "finn sjakkmatt i tre trekk";
        if (themes.includes('crushing')) return "skaff deg en knusende fordel";
        if (themes.includes('advantage')) return "skaff deg en avgjørende fordel";
        if (themes.includes('fork')) return "finn en gaffel";
        if (themes.includes('pin')) return "utnytt en binding";
        return "finn det beste trekket"; // Fallback
    }

    // Exit puzzle mode and return to analysis
    function exitPuzzleMode() {
      isInPuzzleMode = false;
      currentPuzzle = null;
      puzzleSolutionMoves = [];
      currentPuzzleStep = 0;

      // Restore analysis position
      if (savedAnalysisFEN) {
        game.load(savedAnalysisFEN);
        board.position(savedAnalysisFEN);
        savedAnalysisFEN = '';
      }

      // Legg til denne linjen for å sikre at brettet alltid er riktig vei i analysemodus
      board.orientation('white');

      // Restore board title
      if (loadedGame) {
        document.getElementById('boardTitle').textContent = `${loadedGame.white} vs ${loadedGame.black}`;
      } else {
        document.getElementById('boardTitle').textContent = 'Partianalyse';
      }

      console.log('Exited puzzle mode');
    }

    // Handle piece drops on the board
    function handlePieceDrop(source, target, piece, newPos, oldPos, orientation) {
      // If not in puzzle mode, prevent all moves (analysis mode)
      if (!isInPuzzleMode) {
        return 'snapback';
      }

      // In puzzle mode, check if the move is correct
      const playerMove = source + target;
      const expectedMove = puzzleSolutionMoves[currentPuzzleStep * 2 + 1];

      console.log('Player move:', playerMove, 'Expected:', expectedMove);

      if (expectedMove && (playerMove === expectedMove || playerMove === expectedMove.substring(0, 4))) {
        // CORRECT MOVE
        console.log('Correct move!');

        // Execute the move in the game engine
        const move = game.move({
          from: source,
          to: target,
          promotion: expectedMove.length > 4 ? expectedMove[4] : undefined
        });

        if (move) {
          // Highlight the correct move with green
          highlightMove(source, target, 'green', 2000);

          currentPuzzleStep++;

          // Check if puzzle is complete
          if ((currentPuzzleStep * 2 + 1) >= puzzleSolutionMoves.length) {
            completePuzzle();
            return;
          }

          // If not complete, play opponent's response after 500ms
          setTimeout(() => {
            const opponentMove = puzzleSolutionMoves[currentPuzzleStep * 2];

            if (opponentMove) {
              const oppMove = game.move({
                from: opponentMove.substring(0, 2),
                to: opponentMove.substring(2, 4),
                promotion: opponentMove.length > 4 ? opponentMove[4] : undefined
              });

              if (oppMove) {
                board.position(game.fen());

                // Highlight opponent's move with yellow
                highlightMove(opponentMove.substring(0, 2), opponentMove.substring(2, 4), 'yellow', 2000);

                // Update board title for next move
                const playerColorName = game.turn() === 'w' ? 'hvit' : 'svart';
                const instruction = translateThemeToInstruction(currentPuzzle.Themes);
                document.getElementById('boardTitle').textContent = `Du spiller ${playerColorName}, kan du ${instruction}?`;
              }
            }
          }, 500);
        }

        return; // Allow the move
      } else {
        // WRONG MOVE
        console.log('Wrong move!');

        // Highlight the wrong square briefly
        highlightMove(source, source, 'red', 1000);

        // Update board title
        document.getElementById('boardTitle').textContent = "Feil, prøv igjen!";

        return 'snapback'; // Snap piece back
      }
    }

    /********************* UI: kategorier & navigasjon *********************/
    function onTab(e){ const c=e.currentTarget.dataset.c; if(c===current) return; document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected', String(b===e.currentTarget))); loadCategory(c); }
    function loadCategory(category){ current=category; dkOn=false; document.getElementById('dkart').hidden=true; const title=document.getElementById('boardTitle'); const names={opening:'Åpningsanalyse',tactics:'Taktisk analyse',strategy:'Strategisk analyse',endgame:'Sluttspillsanalyse',skills:'Kjerneferdighetstrening'}; if(!loadedGame){ title.textContent=names[category]||'Partianalyse'; game=new Chess(); sanList=[]; idx=0; board.position('start'); renderMoveList(); updateButtons(); } else { title.textContent=`${loadedGame.white} vs ${loadedGame.black}`; } }

    function renderMoveList(){
      const list=document.getElementById('moveList');
      list.innerHTML='';

      if(sanList.length===0){
        list.innerHTML='<div style="padding:20px;text-align:center;color:var(--muted);">Ingen parti lastet.<br>Bruk PGN‑knappen.</div>';
        return;
      }


      for(let i=0;i<sanList.length;i+=2){
        const rn=Math.floor(i/2)+1; const row=document.createElement('div'); row.className='ply';
        const num=document.createElement('strong'); num.textContent=rn+'.'; row.appendChild(num);
        const w=document.createElement('button'); w.type='button'; w.className='san'; w.textContent=sanList[i]; w.dataset.i=i; w.addEventListener('click',()=>goTo(i+1));
        if(evaluations[i+1]){
          const ev=document.createElement('span');
          ev.className='eval';
          const cls=getEvalClass(evaluations[i+1]);
          if(cls) ev.classList.add(cls);
          ev.textContent=evaluations[i+1];

          // Add source indicator
          if(enhancedEvals[i+1]) {
            const source = enhancedEvals[i+1].source;
            if(source === 'Opening') {
              ev.style.borderBottom = '2px solid var(--primary)';
              ev.title = 'Åpningsbok-evaluering';
              if(enhancedEvals[i+1].stats) {
                ev.title += `\n${enhancedEvals[i+1].stats.totalGames} partier`;
              }
            } else if(source === 'PGN') {
              ev.style.borderBottom = '2px solid var(--accent)';
              ev.title = 'PGN-evaluering';
            } else if(source === 'Stockfish') {
              ev.style.borderBottom = '2px solid var(--ok)';
              ev.title = 'Stockfish-evaluering';
            }
          }
          w.appendChild(ev);
        }

        // Legg til tidsbruk hvis tilgjengelig (hvits trekk)
        if (timeSpentList[i] !== undefined) {
          const ts = document.createElement('span');
          ts.className = 'time-spent';
          ts.textContent = ` (${Math.round(timeSpentList[i])}s)`;
          w.appendChild(ts);
        }

        row.appendChild(w);
        if(sanList[i+1]){
          const b=document.createElement('button');
          b.type='button';
          b.className='san';
          b.textContent=sanList[i+1];
          b.dataset.i=i+1;
          b.addEventListener('click',()=>goTo(i+2));

          if(evaluations[i+2]){
            const ev2=document.createElement('span');
            ev2.className='eval';
            const cls2=getEvalClass(evaluations[i+2]);
            if(cls2) ev2.classList.add(cls2);
            ev2.textContent=evaluations[i+2];

            // Add source indicator for black move
            if(enhancedEvals[i+2]) {
              const source = enhancedEvals[i+2].source;
              if(source === 'Opening') {
                ev2.style.borderBottom = '2px solid var(--primary)';
                ev2.title = 'Åpningsbok-evaluering';
                if(enhancedEvals[i+2].stats) {
                  ev2.title += `\n${enhancedEvals[i+2].stats.totalGames} partier`;
                }
              } else if(source === 'PGN') {
                ev2.style.borderBottom = '2px solid var(--accent)';
                ev2.title = 'PGN-evaluering';
              } else if(source === 'Stockfish') {
                ev2.style.borderBottom = '2px solid var(--ok)';
                ev2.title = 'Stockfish-evaluering';
              }
            }
            b.appendChild(ev2);
          }

          // Legg til tidsbruk hvis tilgjengelig (svarts trekk)
          if (timeSpentList[i + 1] !== undefined) {
            const ts2 = document.createElement('span');
            ts2.className = 'time-spent';
            ts2.textContent = ` (${Math.round(timeSpentList[i + 1])}s)`;
            b.appendChild(ts2);
          }

          row.appendChild(b);
        }
        list.appendChild(row);
      }
      highlightActive();
			renderEvalGraph();      // tegn/oppdater grafen når trekklisten oppdateres
			updateEvalNowMarker();  // plasser "nå"-markør i grafen
      if(window.matchMedia('(max-width:760px)').matches){ document.getElementById('panelToggle').style.display='inline-flex'; } else { document.getElementById('panelToggle').style.display='none'; document.getElementById('overlay').classList.remove('show'); document.getElementById('sidepanel').classList.remove('open'); }
    }

    function highlightActive(){ document.querySelectorAll('.san').forEach(b=>b.classList.remove('active')); const activeIndex=idx-1; if(activeIndex>=0){ const btn=document.querySelector(`.san[data-i="${activeIndex}"]`); if(btn) btn.classList.add('active'); } ensureActiveVisible(); }

    function ensureActiveVisible(){ const list=document.getElementById('moveList'); const btn=list.querySelector('.san.active'); if(!btn) return; const lr=list.getBoundingClientRect(); const br=btn.getBoundingClientRect(); if(br.top<lr.top){ list.scrollTop -= (lr.top - br.top) + btn.offsetHeight; } else if(br.bottom>lr.bottom){ list.scrollTop += (br.bottom - lr.bottom) + btn.offsetHeight; } }

		function parseEvalToNumber(evStr) {
			if (!evStr) return 0;
			const s = String(evStr).trim();

			// Mate (#±n)
			if (s.startsWith('#')) {
				// '#-3' => -10, '#5'/'#+5' => +10
				return s.includes('-') ? -10.0 : 10.0;
			}
			// Alternativ "M±n"
			const m = s.match(/^M(-?\d+)$/i);
			if (m) return parseInt(m[1], 10) < 0 ? -10.0 : 10.0;

			// Numerisk
			const n = Number(s);
			return Number.isFinite(n) ? n : 0;
		}

		// Gir SAN med trekknummer, og "..." for svart (som i tooltip-kravet)
		function prettyMoveLabel(plyIndex, sanList) {
			if (plyIndex <= 0) return '0. start';
			const moveNum = Math.ceil(plyIndex / 2);
			const isWhite = (plyIndex % 2 === 1);
			const san = sanList[plyIndex - 1] || '?';
			return isWhite ? `${moveNum}. ${san}` : `${moveNum}… ${san}`;
		}

		// Tegn eval-grafen
		function renderEvalGraph() {
			const host = document.getElementById('evalGraph');
			if (!host) return;

			// Tomt eller ingen parti
			if (!Array.isArray(evaluations) || evaluations.length === 0 || !Array.isArray(sanList)) {
				host.innerHTML = '<div style="padding:8px;color:var(--muted);font-size:12px;text-align:center;">(ingen evaluering tilgjengelig)</div>';
				return;
			}

			// Bygg tallserie i "pawns" for alle posisjoner (0=startpos)
			const vals = evaluations.map(parseEvalToNumber);

			// For sikkerhets skyld: fyll manglende med siste kjente
			for (let i = 1; i < vals.length; i++) {
				if (!Number.isFinite(vals[i])) vals[i] = vals[i - 1];
			}

			const N = vals.length;
			if (N < 2) {
				host.innerHTML = '';
				return;
			}

			// Finn y-skala (symmetrisk)
			const absMax = Math.max(1.0, ...vals.map(v => Math.abs(v)));
			// Dempe ekstreme outliers så kurven holder seg lesbar
			const yMax = Math.min(Math.max(absMax, 3.0), 8.0);

			// Tegne-boks
			const W = host.clientWidth || 480;
			const H = 140;
			const padL = 6, padR = 6, padT = 6, padB = 6;
			const innerW = Math.max(1, W - padL - padR);
			const innerH = Math.max(1, H - padT - padB);

			// Skalaer
			const xOf = i => padL + (innerW * i) / (N - 1);
			const yOf = v => padT + (innerH * (1 - ((v + yMax) / (2 * yMax)))); // 0-linje midt i (v=0 ⇒ midt)

			// Bygg path for kurve
			let d = '';
			for (let i = 0; i < N; i++) {
				const x = xOf(i), y = yOf(vals[i]);
				d += (i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`);
			}

			// Areal over og under 0.0 (midtlinjen)
			const yZero = yOf(0);
			const areaPos = `M ${xOf(0)} ${yZero}` +
											vals.map((v, i) => ` L ${xOf(i)} ${Math.min(yZero, yOf(v))}`).join('') +
											` L ${xOf(N-1)} ${yZero} Z`;
			const areaNeg = `M ${xOf(0)} ${yZero}` +
											vals.map((v, i) => ` L ${xOf(i)} ${Math.max(yZero, yOf(v))}`).join('') +
											` L ${xOf(N-1)} ${yZero} Z`;

			// Punkter (vi bruker dem til hover/klikk; visuelt er de diskrete)
			const circles = [];
			for (let i = 0; i < N; i++) {
				const x = xOf(i), y = yOf(vals[i]);
				circles.push(`<circle class="pt" r="3" cx="${x}" cy="${y}" data-i="${i}" />`);
			}

			// SVG
			host.innerHTML = `
				<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="false" role="img">
					<line class="zero" x1="${padL}" y1="${yZero}" x2="${padL + innerW}" y2="${yZero}"></line>
					<path class="area-pos" d="${areaPos}"></path>
					<path class="area-neg" d="${areaNeg}"></path>
					<path class="curve" d="${d}"></path>
					<g class="points">${circles.join('')}</g>
					<line class="now" id="evalNowLine" x1="${xOf(idx)}" y1="${padT}" x2="${xOf(idx)}" y2="${padT + innerH}"></line>
				</svg>
			`;

			// Tooltip
			let tip;
			const ensureTip = () => {
				if (!tip) {
					tip = document.createElement('div');
					tip.className = 'eval-tooltip';
					document.body.appendChild(tip);
				}
				return tip;
			};

			const svg = host.querySelector('svg');
			const pts = host.querySelectorAll('.pt');

			// Hover + klikk
			pts.forEach(pt => {
				pt.addEventListener('mousemove', (e) => {
					const i = Number(pt.getAttribute('data-i') || '0');
					const label = prettyMoveLabel(i, sanList);     // linje 1
					const evStr = evaluations[i] || '0.0';         // linje 2
					const t = ensureTip();
					t.innerHTML = `${label}<br/>Eval: ${evStr}`;
					t.style.left = (e.clientX + 10) + 'px';
					t.style.top  = (e.clientY - 16) + 'px';
					t.style.display = 'block';
				});
				pt.addEventListener('mouseleave', () => {
					if (tip) tip.style.display = 'none';
				});
				pt.addEventListener('click', () => {
					const i = Number(pt.getAttribute('data-i') || '0');
					// Gå til posisjonen ETTER dette trekket (i == 0 er startpos)
					goTo(i);
				});
			});
		}

		// Flytt “nå-markør” når idx endres (uten å tegne grafen på nytt)
		function updateEvalNowMarker() {
			const host = document.getElementById('evalGraph');
			if (!host) return;
			const svg = host.querySelector('svg');
			const line = host.querySelector('#evalNowLine');
			if (!svg || !line || !Array.isArray(evaluations) || evaluations.length === 0) return;

			const W = svg.viewBox.baseVal.width;
			const H = svg.viewBox.baseVal.height;
			const padL = 6, padR = 6, padT = 6, padB = 6;
			const innerW = Math.max(1, W - padL - padR);
			const N = evaluations.length;

			const xOf = i => padL + (innerW * i) / (N - 1);
			const x = xOf(Math.max(0, Math.min(idx, N - 1)));

			line.setAttribute('x1', x);
			line.setAttribute('x2', x);
		}

    function getEvalClass(evalStr) {
      if (!evalStr) return null;
      const str = String(evalStr);

      // Mate: se etter M±n
      const mateMatch = str.match(/M(-?\d+)/i);
      if (mateMatch) {
        const n = parseInt(mateMatch[1], 10);
        return n < 0 ? 'negative' : 'positive';
      }

      // Numerisk evaluering
      const numMatch = str.match(/^[+\-]?(\d+(?:\.\d+)?)$/);
      if (numMatch) {
        const val = parseFloat(str);
        if (val > 0.5) return 'positive';
        if (val < -0.5) return 'negative';
      }

      return null;
    }

    function nextMove(){ if(idx>=sanList.length) return; game.move(sanList[idx]); idx++; board.position(game.fen()); highlightActive(); if(dkOn) drawDkart(); updateButtons(); scrollToKeyMoment(idx); updateDynamicOpeningInfo(); updateEvalNowMarker();}
    function prevMove(){ if(idx<=0) return; idx--; game.reset(); for(let i=0;i<idx;i++) game.move(sanList[i]); board.position(game.fen()); highlightActive(); if(dkOn) drawDkart(); updateButtons(); scrollToKeyMoment(idx); updateDynamicOpeningInfo(); updateEvalNowMarker();}
    function goTo(n){ idx=Math.max(0, Math.min(n, sanList.length)); game.reset(); for(let i=0;i<idx;i++) game.move(sanList[i]); board.position(game.fen()); highlightActive(); if(dkOn) drawDkart(); updateButtons(); scrollToKeyMoment(idx); updateDynamicOpeningInfo(); updateEvalNowMarker();}

    function scrollToKeyMoment(moveIndex){
      const box=document.getElementById('explainBox');
      if(!box) return;

      const headers=box.querySelectorAll('h3');
      if(headers.length===0) return;

      // Fix move number and color calculation
      if(moveIndex === 0) return; // Startposisjon, ingen auto-scroll

      // Beregn hvilket trekk som ER utført (ikke neste trekk)
      // moveIndex=1 = 1 trekk utført (1.e4), moveIndex=2 = 2 trekk utført (1.e4 e5)
      const moveNumber = Math.ceil(moveIndex / 2);
      const isWhiteMove = (moveIndex % 2 === 1);
      const color = isWhiteMove ? 'Hvit' : 'Svart';

      console.log(`Auto-scroll: moveIndex=${moveIndex}, moveNumber=${moveNumber}, color=${color}`);

      let target = null;

      // Søk gjennom headers med bedre matching
      for(const header of headers) {
        const text = header.textContent || '';
        console.log(`Checking header: "${text}"`);

        // Match ny format: "### Nøkkeløyeblikk X (Trekk Y. MOVE):" hvor MOVE er faktisk trekk
        let match = text.match(/Nøkkeløyeblikk\s+\d+\s*\(Trekk\s+(\d+)\.\s*([^):]+)\)/i);
        if(match) {
          const headerMoveNum = parseInt(match[1], 10);
          const headerMove = match[2].trim();

          console.log(`Found: Move ${headerMoveNum}, Notation: ${headerMove}`);

          // For ny format, sjekk om trekknummer stemmer og at dette er det riktige trekket
          if(headerMoveNum === moveNumber) {
            const expectedMove = sanList[moveIndex-1];
            if(expectedMove && headerMove === expectedMove) {
              target = header;
              console.log(`✅ Match found for Move ${moveNumber} (${expectedMove})`);
              break;
            }
          }
        }

        // Fallback: Match gammelt format: "### Nøkkeløyeblikk X (Trekk Y. [Farge]):"
        match = text.match(/Nøkkeløyeblikk\s+\d+\s*\(Trekk\s+(\d+)\.\s*\[([^\]]+)\]/i);
        if(match) {
          const headerMoveNum = parseInt(match[1], 10);
          const headerColor = match[2].trim();

          console.log(`Found old format: Move ${headerMoveNum}, Color ${headerColor}`);

          if(headerMoveNum === moveNumber && headerColor.toLowerCase() === color.toLowerCase()) {
            target = header;
            console.log(`✅ Match found for Move ${moveNumber} (${color})`);
            break;
          }
        }
      }

      if(target) {
        // Forbedret scroll-posisjonering som tar hensyn til container bounds
        const containerRect = box.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();

        // Beregn relativ posisjon innenfor containeren
        const relativeTop = targetRect.top - containerRect.top + box.scrollTop;
        const desiredScrollTop = relativeTop - 20; // 20px margin fra topp

        // Sørg for at vi ikke prøver å scrolle utenfor bounds
        const maxScroll = box.scrollHeight - box.clientHeight;
        const finalScrollTop = Math.max(0, Math.min(desiredScrollTop, maxScroll));

        box.scrollTo({
          top: finalScrollTop,
          behavior: 'smooth'
        });

        console.log(`✅ Scrolled to key moment: Move ${moveNumber} (${color}) at scroll position ${finalScrollTop}`);

        // Visuell feedback (blink effect) med forbedret styling
        target.style.transition = 'background-color 0.3s ease';
        target.style.backgroundColor = 'rgba(79, 124, 255, 0.2)';
        target.style.borderLeft = '4px solid var(--primary)';
        target.style.paddingLeft = '8px';

        setTimeout(() => {
          target.style.backgroundColor = '';
          target.style.borderLeft = '';
          target.style.paddingLeft = '';
        }, 2000);
      } else {
        console.log(`❌ No key moment found for Move ${moveNumber} (${color})`);
      }
    }

    function resetPosition(){
      idx=0;
      game.reset();
      board.position('start');
      highlightActive();
      if(dkOn) drawDkart();
      updateButtons();
      updateEvalNowMarker();
    }
    function goToEnd() { goTo(sanList.length); }
    function updateButtons(){ document.getElementById('btnPrev').disabled=(idx===0); document.getElementById('btnNext').disabled=(idx===sanList.length); }

    /********************* Lichess analyse‑lenke *********************/
    function openLichessAnalysis(){ const fen=(game&&game.fen)? game.fen().replace(/ /g,'_') : 'start'; window.open(`https://lichess.org/analysis/${fen}`,'_blank'); }

    /********************* DKART *********************/
    function toggleDkart(){ dkOn=!dkOn; document.getElementById('btnDkart').setAttribute('aria-pressed',dkOn); const el=document.getElementById('dkart'); el.hidden=!dkOn; if(dkOn) drawDkart(); }
    function drawDkart(){
      const overlay=document.getElementById('dkart');
      overlay.innerHTML='';
      const rect=document.getElementById('board').getBoundingClientRect();
      const s=rect.width/8;
      const grid=dominanceGrid(game.fen());

      // Beregn total og vektet sum
      let totalSum = 0;
      let weightedSum = 0;
      const weights = SJAKKARO_CONFIG.dominanceWeights.matrix;

      for(let r=0;r<8;r++){
        for(let c=0;c<8;c++){
          const v=Math.max(-3,Math.min(3,grid[r][c]));
          const weight = weights[r][c];

          totalSum += v;
          weightedSum += v * weight;

          // Skip A8 (0,0) og H8 (0,7) felter - disse dekkes av sum-displays
          if(!((r === 0 && c === 0) || (r === 0 && c === 7))) {
            const square = createDominanceSquare(r, c, v, s);
            overlay.appendChild(square);
          }
        }
      }

      // Legg til A8: Total sum display (øvre venstre)
      const totalDisplay = createSumDisplay(totalSum, 0, 0, s, 'total');
      overlay.appendChild(totalDisplay);

      // Legg til H8: Weighted sum display (øvre høyre)
      const weightedDisplay = createSumDisplay(weightedSum, 0, 7, s, 'weighted');
      overlay.appendChild(weightedDisplay);

      // Legg til midtlinje (valgfri)
      const midline = createMidline();
      overlay.appendChild(midline);
    }
    function dominanceGrid(fen){ const pos=parseFEN(fen); const g=Array.from({length:8},()=>Array(8).fill(0)); for(let r=0;r<8;r++){ for(let c=0;c<8;c++){ let w=0,b=0; for(const p of pos.white){ if(canAttack(p,{row:r,col:c},pos)) w++; } for(const p of pos.black){ if(canAttack(p,{row:r,col:c},pos)) b++; } g[r][c]=w-b; } } return g; }

    function calculateWeightedDominanceScore(dominanceGrid) {
      const weights = SJAKKARO_CONFIG.dominanceWeights.matrix;
      let score = 0;

      for(let r = 0; r < 8; r++) {
        for(let c = 0; c < 8; c++) {
          score += dominanceGrid[r][c] * weights[r][c];
        }
      }

      return score;
    }

    function createDominanceSquare(row, col, value, squareSize) {
      const square = document.createElement('div');
      square.className = `dk-square dk-${value}`;
      square.style.left = (col * squareSize) + 'px';
      square.style.top = (row * squareSize) + 'px';
      square.style.width = squareSize + 'px';
      square.style.height = squareSize + 'px';
      square.textContent = value === 0 ? '' : (value > 0 ? `+${value}` : `${value}`);
      return square;
    }

    function createSumDisplay(score, row, col, squareSize, type) {
      const display = document.createElement('div');
      display.className = type === 'total' ? 'dominance-total-sum' : 'dominance-weighted-score';

      // Posisjon på brett
      display.style.left = (col * squareSize) + 'px';
      display.style.top = (row * squareSize) + 'px';
      display.style.width = squareSize + 'px';
      display.style.height = squareSize + 'px';

      // Fargekoding basert på score
      if (score > 0) {
        display.classList.add('positive');
        display.textContent = '+' + score;
      } else if (score < 0) {
        display.classList.add('negative');
        display.textContent = score;
      } else {
        display.classList.add('neutral');
        display.textContent = '0';
      }

      return display;
    }

    function createMidline() {
      const midline = document.createElement('div');
      midline.className = 'dominance-midline';
      return midline;
    }
    function parseFEN(fen){ const boardPart=fen.split(' ')[0]; const rows=boardPart.split('/'); const P={white:[],black:[]}; for(let r=0;r<8;r++){ let c=0; for(const ch of rows[r]){ if(/\d/.test(ch)) c += parseInt(ch,10); else { const piece={type:ch.toLowerCase(),row:r,col:c,color:/[A-Z]/.test(ch)?'white':'black'}; P[piece.color].push(piece); c++; } } } return P; }
    function canAttack(piece,target,pos){ const dx=target.col-piece.col, dy=target.row-piece.row; switch(piece.type){ case 'p':{ const dir=piece.color==='white'?-1:1; return dy===dir && Math.abs(dx)===1; } case 'r':{ if(dx===0||dy===0) return clearLine(piece,target,pos); return false; } case 'n': return (Math.abs(dx)===2&&Math.abs(dy)===1)||(Math.abs(dx)===1&&Math.abs(dy)===2); case 'b':{ if(Math.abs(dx)===Math.abs(dy)) return clearLine(piece,target,pos); return false; } case 'q':{ if(dx===0||dy===0||Math.abs(dx)===Math.abs(dy)) return clearLine(piece,target,pos); return false; } case 'k': return Math.abs(dx)<=1 && Math.abs(dy)<=1; default: return false; } }
    function clearLine(from,to,pos){ const dx=Math.sign(to.col-from.col), dy=Math.sign(to.row-from.row); let r=from.row+dy, c=from.col+dx; const all=[...pos.white,...pos.black]; while(r!==to.row || c!==to.col){ if(all.some(p=>p.row===r&&p.col===c)) return false; r+=dy; c+=dx; } return true; }

    /********************* Weight Matrix Editor *********************/
    function initializeWeightMatrix() {
      const container = document.getElementById('weightMatrix');
      if (!container) return;

      // Sjekk om matrisen allerede er opprettet
      if (container.children.length === 64) return;

      // Opprett 8x8 grid
      container.innerHTML = '';
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const cell = document.createElement('input');
          cell.type = 'number';
          cell.min = '0';
          cell.max = '9';
          cell.className = 'matrix-cell';
          cell.dataset.row = row;
          cell.dataset.col = col;
          cell.addEventListener('input', onWeightCellChange);
          container.appendChild(cell);
        }
      }
    }

    function loadWeightMatrixEditor() {
      const selector = document.getElementById('weightPresetSelector');
      const container = document.getElementById('weightMatrix');
      const presetInfo = document.getElementById('presetInfo');

      if (!selector || !container) return;

      // Last aktiv preset fra localStorage eller bruk default
      const activePreset = localStorage.getItem('dkartWeightPreset') || SJAKKARO_CONFIG.dominanceWeights.activePreset;
      selector.value = activePreset;

      // Oppdater preset info
      updatePresetInfo(activePreset);

      // Last matrix fra localStorage eller bruk preset
      let matrix;
      if (activePreset === 'custom') {
        const saved = localStorage.getItem('dkartCustomMatrix');
        matrix = saved ? JSON.parse(saved) : SJAKKARO_CONFIG.dominanceWeights.matrix;
      } else {
        matrix = SJAKKARO_CONFIG.dominanceWeights.presets[activePreset]?.matrix || SJAKKARO_CONFIG.dominanceWeights.matrix;
      }

      // Fyll matrise med verdier
      const cells = container.querySelectorAll('.matrix-cell');
      cells.forEach(cell => {
        const row = parseInt(cell.dataset.row);
        const col = parseInt(cell.dataset.col);
        cell.value = matrix[row][col];
      });

      // Vis/skjul matrix editor
      const editor = document.getElementById('weightMatrixEditor');
      if (editor) {
        editor.style.display = activePreset === 'custom' ? 'block' : 'none';
      }
    }

    function onWeightPresetChange(event) {
      const preset = event.target.value;
      updatePresetInfo(preset);

      const editor = document.getElementById('weightMatrixEditor');
      const container = document.getElementById('weightMatrix');

      if (preset === 'custom') {
        if (editor) editor.style.display = 'block';

        // Last custom matrix fra localStorage, eller bruk current matrix som fallback
        const saved = localStorage.getItem('dkartCustomMatrix');
        const matrix = saved ? JSON.parse(saved) : SJAKKARO_CONFIG.dominanceWeights.matrix;

        // Fyll matrix editor med verdier
        if (container) {
          const cells = container.querySelectorAll('.matrix-cell');
          cells.forEach(cell => {
            const row = parseInt(cell.dataset.row);
            const col = parseInt(cell.dataset.col);
            cell.value = matrix[row][col];
          });
        }
      } else {
        if (editor) editor.style.display = 'none';
        // Last preset matrix
        const matrix = SJAKKARO_CONFIG.dominanceWeights.presets[preset]?.matrix;
        if (matrix && container) {
          const cells = container.querySelectorAll('.matrix-cell');
          cells.forEach(cell => {
            const row = parseInt(cell.dataset.row);
            const col = parseInt(cell.dataset.col);
            cell.value = matrix[row][col];
          });
        }
      }
    }

    function onWeightCellChange(event) {
      // Automatisk bytt til "custom" når bruker endrer verdier
      const selector = document.getElementById('weightPresetSelector');
      if (selector && selector.value !== 'custom') {
        selector.value = 'custom';
        updatePresetInfo('custom');
        const editor = document.getElementById('weightMatrixEditor');
        if (editor) editor.style.display = 'block';
      }

      // Valider input (0-9)
      let value = parseInt(event.target.value);
      if (isNaN(value) || value < 0) value = 0;
      if (value > 9) value = 9;
      event.target.value = value;
    }

    function updatePresetInfo(preset) {
      const presetInfo = document.getElementById('presetDescription');
      if (!presetInfo) return;

      const presetData = SJAKKARO_CONFIG.dominanceWeights.presets[preset];
      if (presetData) {
        presetInfo.textContent = presetData.description;
      } else if (preset === 'custom') {
        presetInfo.textContent = 'Egendefinert vektmatrise - rediger verdiene nedenfor';
      }
    }

    function saveWeightMatrixConfig() {
      const selector = document.getElementById('weightPresetSelector');
      const container = document.getElementById('weightMatrix');

      if (!selector || !container) return;

      const activePreset = selector.value;
      localStorage.setItem('dkartWeightPreset', activePreset);

      if (activePreset === 'custom') {
        // Lagre custom matrix
        const matrix = [];
        for (let row = 0; row < 8; row++) {
          matrix[row] = [];
          for (let col = 0; col < 8; col++) {
            const cell = container.querySelector(`[data-row="${row}"][data-col="${col}"]`);
            matrix[row][col] = parseInt(cell.value) || 0;
          }
        }
        localStorage.setItem('dkartCustomMatrix', JSON.stringify(matrix));
      }

      // Oppdater aktiv konfiguration
      updateActiveWeightMatrix();
    }

    function resetWeightMatrixToDefault() {
      const selector = document.getElementById('weightPresetSelector');
      if (selector) {
        selector.value = 'standard';
        updatePresetInfo('standard');
      }

      localStorage.removeItem('dkartWeightPreset');
      localStorage.removeItem('dkartCustomMatrix');

      // Last default matrix
      loadWeightMatrixEditor();
      updateActiveWeightMatrix();
    }

    function updateActiveWeightMatrix() {
      const preset = localStorage.getItem('dkartWeightPreset') || 'standard';

      if (preset === 'custom') {
        const saved = localStorage.getItem('dkartCustomMatrix');
        if (saved) {
          SJAKKARO_CONFIG.dominanceWeights.matrix = JSON.parse(saved);
        }
      } else {
        const presetMatrix = SJAKKARO_CONFIG.dominanceWeights.presets[preset]?.matrix;
        if (presetMatrix) {
          SJAKKARO_CONFIG.dominanceWeights.matrix = presetMatrix;
        }
      }

      SJAKKARO_CONFIG.dominanceWeights.activePreset = preset;

      // Oppdater Dkart hvis det er aktivt
      if (dkOn) {
        drawDkart();
      }
    }

    document.addEventListener('DOMContentLoaded',init);
