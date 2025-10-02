// config.js

const SJAKKARO_CONFIG = {
  // Generelle innstillinger
  SERVER_URL: 'http://localhost:8080',
  cacheExpiry: 24 * 60 * 60 * 1000, // 24 timer for åpningsbok-cache
  maxCacheSize: 500,

  // Standard rating for eleven
  defaultElevRating: 800,

  // Stockfish-motorinnstillinger (MVP - felles for all analyse foreløpig)
  stockfish: {
    // Brukes for full partianalyse
    gameAnalysis: {
      mode: 'movetime',
      movetime: 2000,
      depth: 15
    },
    // Brukes for manuell analyse av én posisjon
    positionAnalysis: {
      mode: 'movetime',
      movetime: 3000, // Mer tid for dypere analyse
      depth: 21,
      multiPV: 1 // MVP: Holder oss til 1 for å unngå kompleks parsing
    },
    // Generelt
    timeout: 10000 // 10 sekunder hard timeout per trekk
  },

  // Innstillinger for Lichess Åpningsbok
  openingBook: {
    enabled: true,
    maxPlies: 60,
    minGames: 1,
    speeds: 'blitz,rapid,classical',
    ratings: '1600,1800,2000,2200',
    strategy: 'balanced'
  },

  // Innstillinger for oppgaver (Puzzles)
  puzzles: {
    ratingRange: {
      min: 800,
      max: 1400
    },
    validThemes: [
      'advancedPawn', 'advantage', 'anastasiaMate', 'arabianMate', 'attackingF2F7', 'attraction', 'backRankMate',
      'bishopEndgame', 'bodenMate', 'capturingDefender', 'castling', 'clearance', 'crushing', 'defensiveMove',
      'deflection', 'discoveredAttack', 'doubleBishopMate', 'doubleCheck', 'dovetailMate', 'endgame', 'enPassant',
      'equality', 'escape', 'fork', 'hangingPiece', 'hookMate', 'interference', 'intermezzo', 'kingsideAttack',
      'knightEndgame', 'long', 'master', 'mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5', 'middlegame',
      'oneMove', 'opening', 'pawnEndgame', 'pin', 'promotion', 'queenEndgame', 'queenRookEndgame', 'queensideAttack',
      'quietMove', 'rookEndgame', 'sacrifice', 'short', 'skewer', 'smotheredMate', 'superGM', 'trappedPiece',
      'underPromotion', 'veryLong', 'xRayAttack', 'zugzwang'
    ]
  },

  // Innstillinger for Dkart (Dominanskart) vekting
  dominanceWeights: {
    // Standard vektmatrise (som i Åpningsspill_D4.html)
    // Rad 0 = 8. rad (a8-h8), Rad 7 = 1. rad (a1-h1)
    matrix: [
      [1,1,1,1,1,1,1,1], // rad 8 (a8-h8)
      [1,1,1,1,1,1,1,1], // rad 7 (a7-h7)
      [1,1,2,2,2,2,1,1], // rad 6 (a6-h6) - utvidet sentrum
      [1,1,2,4,4,2,1,1], // rad 5 (a5-h5) - d5,e5 = sentrum
      [1,1,2,4,4,2,1,1], // rad 4 (a4-h4) - d4,e4 = sentrum
      [1,1,2,2,2,2,1,1], // rad 3 (a3-h3) - utvidet sentrum
      [1,1,1,1,1,1,1,1], // rad 2 (a2-h2)
      [1,1,1,1,1,1,1,1]  // rad 1 (a1-h1)
    ],
    presets: {
      'standard': {
        name: 'Standard (sentrum 4x)',
        description: 'Sentrum (d4,d5,e4,e5) vekt 4, utvidet sentrum vekt 2, resten vekt 1',
        matrix: [
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,2,2,2,2,1,1],
          [1,1,2,4,4,2,1,1],
          [1,1,2,4,4,2,1,1],
          [1,1,2,2,2,2,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1]
        ]
      },
      'center_focus': {
        name: 'Kun sentrum',
        description: 'Kun de fire sentrumsfelter teller, resten ignoreres',
        matrix: [
          [0,0,0,0,0,0,0,0],
          [0,0,0,0,0,0,0,0],
          [0,0,0,0,0,0,0,0],
          [0,0,0,1,1,0,0,0],
          [0,0,0,1,1,0,0,0],
          [0,0,0,0,0,0,0,0],
          [0,0,0,0,0,0,0,0],
          [0,0,0,0,0,0,0,0]
        ]
      },
      'equal': {
        name: 'Alle felt likt',
        description: 'Alle felt på brettet har samme vekt',
        matrix: [
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1],
          [1,1,1,1,1,1,1,1]
        ]
      },
      'endgame_focus': {
        name: 'Sluttspillsfokus',
        description: 'Sentrale felt og kantlinjer vektlegges for sluttspill',
        matrix: [
          [2,1,1,2,2,1,1,2],
          [1,1,1,2,2,1,1,1],
          [1,1,3,3,3,3,1,1],
          [2,2,3,4,4,3,2,2],
          [2,2,3,4,4,3,2,2],
          [1,1,3,3,3,3,1,1],
          [1,1,1,2,2,1,1,1],
          [2,1,1,2,2,1,1,2]
        ]
      }
    },
    // Aktiv preset (kan endres av bruker)
    activePreset: 'standard'
  }
};