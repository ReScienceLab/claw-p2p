const SEATS = ['east', 'south', 'west', 'north']
const SEAT_CHARS = { east: '东', south: '南', west: '西', north: '北' }
const WIND_LABELS = { 1: 'E', 2: 'S', 3: 'W', 4: 'N' }

const svgCache = {}

function loadTileSVG(tile) {
  if (svgCache[tile]) return svgCache[tile]
  const p = fetch(`/tiles/${tile}.svg`)
    .then(r => r.ok ? r.text() : '')
    .catch(() => '')
  svgCache[tile] = p
  return p
}

const ALL_TILES = []
for (const suit of ['m', 'p', 's']) {
  for (let r = 1; r <= 9; r++) ALL_TILES.push(r + suit)
}
for (let r = 1; r <= 7; r++) ALL_TILES.push(r + 'z')
ALL_TILES.forEach(loadTileSVG)

const $ = id => document.getElementById(id)

function createTileEl(tile, opts = {}) {
  const div = document.createElement('div')
  let cls = 'tile'
  if (opts.small) cls += ' small'
  if (opts.hidden) cls += ' hidden-tile'
  if (opts.lastDiscard) cls += ' last-discard'
  if (opts.animate) cls += ' anim-appear'
  div.className = cls
  if (!opts.hidden && tile) {
    loadTileSVG(tile).then(svg => { if (svg) div.innerHTML = svg })
  }
  return div
}

let currentTurnSeat = null
let gameState = null

function renderState(s) {
  gameState = s

  const roundLabel = (WIND_LABELS[s.round] || 'E') + (s.gameCount || 1)
  $('round').textContent = roundLabel
  $('wall').textContent = s.wallSize ?? '—'

  if (s.doraIndicator) {
    const doraEl = $('dora')
    doraEl.innerHTML = ''
    doraEl.appendChild(document.createTextNode('Dora '))
    doraEl.appendChild(createTileEl(s.doraIndicator, { small: true }))
  } else {
    $('dora').innerHTML = ''
  }

  for (const seat of SEATS) {
    const p = s.participants?.[seat]
    $(`nm-${seat}`).textContent = p?.name ?? 'Waiting...'
    const scoreEl = $(`sc-${seat}`)
    if (scoreEl && s.scores?.[seat] !== undefined) {
      scoreEl.textContent = s.scores[seat].toLocaleString()
    }

    const hd = $(`hd-${seat}`)
    hd.innerHTML = ''
    const cnt = s.hands?.[seat]?.count ?? 0
    for (let i = 0; i < cnt; i++) {
      hd.appendChild(createTileEl(null, { hidden: true, small: seat === 'west' || seat === 'east' }))
    }

    const pondEl = $(`pond-${seat}`)
    if (pondEl) {
      pondEl.innerHTML = ''
      for (const tile of (s.discards?.[seat] ?? [])) {
        pondEl.appendChild(createTileEl(tile, { small: true }))
      }
    }

    const ml = $(`ml-${seat}`)
    ml.innerHTML = ''
    for (const meld of (s.melds?.[seat] ?? [])) {
      const group = document.createElement('div')
      group.className = 'meld-group'
      for (const tile of (meld.tiles || meld.Tiles || [])) {
        group.appendChild(createTileEl(tile, { small: true }))
      }
      ml.appendChild(group)
    }
  }

  updateTurnIndicator(null)
}

function renderMove(d) {
  if (d.wallSize !== undefined) $('wall').textContent = d.wallSize

  if (d.action === 'discard' && d.tile && d.seat) {
    const pondEl = $(`pond-${d.seat}`)
    if (pondEl) {
      pondEl.appendChild(createTileEl(d.tile, { small: true, lastDiscard: true, animate: true }))
    }
  }

  if (d.action === 'draw' && d.seat) {
    currentTurnSeat = d.seat
    updateTurnIndicator(d.seat)
  }
}

function renderThinking(d) {
  for (const s of SEATS) {
    const el = $(`th-${s}`)
    if (!el) continue
    el.innerHTML = s === d.seat ? '<span class="thinking-dot"></span>' : ''
  }
  if (d.seat) {
    currentTurnSeat = d.seat
    updateTurnIndicator(d.seat)
  }
}

function updateTurnIndicator(activeSeat) {
  const seat = activeSeat || currentTurnSeat
  for (const s of SEATS) {
    const windEl = $(`wind-${s}`)
    if (windEl) windEl.classList.toggle('active', s === seat)
    const badgeEl = $(`badge-${s}`)
    if (badgeEl) badgeEl.classList.toggle('active-turn', s === seat)
  }
}

function renderLobby(d) {
  for (const s of SEATS) {
    const p = d.participants?.[s]
    $(`nm-${s}`).textContent = p?.name ?? 'Waiting...'
  }
}

function showGameover(d) {
  const ov = $('overlay')
  const tilesEl = $('ov-tiles')
  tilesEl.innerHTML = ''

  if (d.winner) {
    $('ov-win').textContent = (SEAT_CHARS[d.winner] || d.winner.toUpperCase()) + ' Wins!'
    $('ov-pts').textContent = d.points + ' pts ' + (d.isTsumo ? '(Tsumo)' : '(Ron)')
    $('ov-yaku').textContent = (d.yaku ?? []).join(' / ')
    if (d.winTile) {
      tilesEl.appendChild(createTileEl(d.winTile))
    }
  } else {
    $('ov-win').textContent = 'Draw Game'
    $('ov-pts').textContent = d.reason ?? 'Wall exhausted'
    $('ov-yaku').textContent = ''
  }
  ov.classList.add('show')
  setTimeout(() => ov.classList.remove('show'), 7000)
}

function appendLog(from, to, type, summary, ts) {
  const log = $('log')
  const el = document.createElement('div')
  el.className = 'log-entry'
  const time = new Date(ts).toLocaleTimeString('en', { hour12: false })

  const typeColor = {
    'game:deal': '#81c784',
    'game:draw': '#64b5f6',
    'game:discard_event': '#ffb74d',
    'game:claim_window': '#ce93d8',
    'game:meld': '#4dd0e1',
    'game:gameover': '#e57373',
  }[type] || '#a5d6a7'

  el.innerHTML = `<div class="route">${from} → ${to} <b style="color:${typeColor}">${type}</b><span class="ts">${time}</span></div><div class="payload">${summary}</div>`
  log.prepend(el)
  while (log.children.length > 200) log.removeChild(log.lastChild)
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/ws`)

  ws.onopen = () => {
    $('conn-dot').classList.add('on')
    $('conn-status').innerHTML = '<span class="conn-dot on" id="conn-dot"></span>Connected'
  }
  ws.onclose = () => {
    $('conn-status').innerHTML = '<span class="conn-dot" id="conn-dot"></span>Reconnecting...'
    setTimeout(connect, 3000)
  }
  ws.onerror = () => ws.close()

  ws.onmessage = ({ data }) => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    const { event, data: d } = msg
    switch (event) {
      case 'state':    renderState(d); break
      case 'move':     renderMove(d); break
      case 'thinking': renderThinking(d); break
      case 'lobby':    renderLobby(d); break
      case 'gameover': showGameover(d); break
      case 'p2p':      appendLog(d.from, d.to, d.type, d.summary, d.ts); break
    }
  }
}

connect()
