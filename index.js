// =============================================================================
// Stremio Jellyfin Addon — Node.js para Render.com
// =============================================================================

const JELLYFIN_SERVER   = 'https://jellyfin.vpn4u.cc'
const JELLYFIN_USER     = 'Micas'
const JELLYFIN_PASSWORD = '#Mdsc2003'
const PORT              = process.env.PORT || 3000

// =============================================================================

import http from 'http'
import { URL } from 'url'

const MANIFEST = {
  id: 'personal.stremiojellyfin',
  version: '1.0.0',
  name: 'Jellyfin',
  description: 'A minha biblioteca Jellyfin no Stremio',
  logo: 'https://jellyfin.org/images/logo.svg',
  resources: ['catalog', 'stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [
    {
      type: 'movie',
      id: 'jf-movies',
      name: 'Jellyfin — Filmes',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'jf-series',
      name: 'Jellyfin — Séries',
      extra: [
        { name: 'skip', isRequired: false },
        { name: 'search', isRequired: false }
      ]
    }
  ]
}

// =============================================================================
// Auth cache
// =============================================================================

let cachedAuth = null
let cacheExpiry = 0

// =============================================================================
// HTTP server
// =============================================================================

const server = http.createServer(async (req, res) => {
  const url  = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const send = (data, status = 200) => {
    res.writeHead(status)
    res.end(JSON.stringify(data))
  }

  try {
    // Manifest
    if (path === '/' || path === '/manifest.json') {
      return send(MANIFEST)
    }

    const jf = new Jellyfin()
    await jf.auth()

    // Catalog
    const catalog = path.match(/^\/catalog\/(movie|series)\/[^/]+\.json$/)
    if (catalog) {
      const isMovie = catalog[1] === 'movie'
      const skip    = parseInt(url.searchParams.get('skip') || '0')
      const search  = url.searchParams.get('search') || null
      const items   = await jf.search(skip, isMovie, search)
      return send({ metas: items.map(toMeta) })
    }

    // Stream
    const stream = path.match(/^\/stream\/(movie|series)\/(.+)\.json$/)
    if (stream) {
      const id      = decodeURIComponent(stream[2])
      const streams = await resolveStreams(id, jf)
      return send({ streams })
    }

    // Meta
    if (path.match(/^\/meta\//)) {
      return send({ meta: null })
    }

    res.writeHead(404)
    res.end('Not found')

  } catch (err) {
    console.error(err)
    send({ error: err.message }, 500)
  }
})

server.listen(PORT, () => {
  console.log(`✅ Stremio Jellyfin addon a correr em http://localhost:${PORT}`)
  console.log(`   Manifest: http://localhost:${PORT}/manifest.json`)
})

// =============================================================================
// Jellyfin client
// =============================================================================

class Jellyfin {
  constructor() {
    this.server = JELLYFIN_SERVER.replace(/\/$/, '')
    this._auth  = null
    this.LIMIT  = 20
  }

  clientHeader(token) {
    const base = `MediaBrowser Client="StremioAddon", Device="Node", DeviceId="stremio-node-1", Version="1.0.0"`
    return token ? `${base}, Token="${token}"` : base
  }

  async auth() {
    if (cachedAuth && Date.now() < cacheExpiry) {
      this._auth = cachedAuth
      return
    }

    const res = await fetch(`${this.server}/Users/authenticatebyname`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Emby-Authorization': this.clientHeader(),
        'Authorization': this.clientHeader()
      },
      body: JSON.stringify({ Username: JELLYFIN_USER, Pw: JELLYFIN_PASSWORD })
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Auth falhou (${res.status}): ${body}`)
    }

    this._auth  = await res.json()
    cachedAuth  = this._auth
    cacheExpiry = Date.now() + 60 * 60 * 1000
    console.log(`✅ Jellyfin autenticado como: ${this._auth.User.Name}`)
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      'X-Emby-Authorization': this.clientHeader(this._auth.AccessToken),
      'Authorization': this.clientHeader(this._auth.AccessToken)
    }
  }

  get uid()   { return this._auth.User.Id }
  get token() { return this._auth.AccessToken }

  async get(path) {
    const res = await fetch(`${this.server}${path}`, { headers: this.headers })
    if (!res.ok) throw new Error(`Jellyfin GET ${path} → ${res.status}`)
    return res.json()
  }

  async search(skip, isMovie, searchTerm) {
    const type = isMovie ? 'Movie' : 'Series'
    let url = `${this.server}/Items?userId=${this.uid}&hasImdb=true&Recursive=true`
      + `&IncludeItemTypes=${type}&startIndex=${skip}&limit=${this.LIMIT}`
      + `&sortBy=SortName&Fields=ProviderIds,Overview,ProductionYear`

    if (searchTerm) url += `&searchTerm=${encodeURIComponent(searchTerm)}`

    const res = await fetch(url, { headers: this.headers })
    if (!res.ok) throw new Error(`search falhou: ${res.status}`)
    return (await res.json()).Items || []
  }

  async byImdb(imdbId) {
    const data = await this.get(`/ProvidersIdSearch?ProviderId=${imdbId}`)
    return Array.isArray(data) ? data : (data.Items || [])
  }

  async item(id) {
    return this.get(`/Users/${this.uid}/Items/${id}?Fields=MediaSources,MediaStreams,Overview`)
  }

  async seasons(seriesId) {
    return (await this.get(`/Shows/${seriesId}/Seasons?userId=${this.uid}`)).Items || []
  }

  async episodes(seriesId, seasonId) {
    return (await this.get(
      `/Shows/${seriesId}/Episodes?seasonId=${seasonId}&userId=${this.uid}&Fields=MediaSources,MediaStreams,IndexNumber`
    )).Items || []
  }
}

// =============================================================================
// Stream resolver
// =============================================================================

async function resolveStreams(id, jf) {
  let item

  if (id.includes(':')) {
    const [imdbId, s, e] = id.split(':')
    const season  = parseInt(s)
    const episode = parseInt(e)

    const series = (await jf.byImdb(imdbId))?.[0]
    if (!series) return []

    const seasonItem = (await jf.seasons(series.Id)).find(x => x.IndexNumber === season)
    if (!seasonItem) return []

    const episodeItem = (await jf.episodes(series.Id, seasonItem.Id)).find(x => x.IndexNumber === episode)
    if (!episodeItem) return []

    item = await jf.item(episodeItem.Id)
  } else {
    const results = await jf.byImdb(id)
    if (!results?.length) return []
    item = await jf.item(results[0].Id)
  }

  if (!item?.MediaSources?.length) return []

  return item.MediaSources.map(source => {
    const video  = source.MediaStreams?.find(s => s.Type === 'Video')
    const itemId = toUuid(item.Id)
    return {
      url: `${JELLYFIN_SERVER}/videos/${itemId}/stream.mkv?static=true&api_key=${jf.token}&mediaSourceId=${source.Id}`,
      name: 'Jellyfin',
      description: video?.DisplayTitle || source.Name || 'Stream'
    }
  })
}

// =============================================================================
// Utils
// =============================================================================

function toMeta(item) {
  return {
    id:          item.ProviderIds?.Imdb,
    type:        item.Type === 'Movie' ? 'movie' : 'series',
    name:        item.Name,
    poster:      `${JELLYFIN_SERVER}/Items/${item.Id}/Images/Primary`,
    year:        item.ProductionYear,
    description: item.Overview || ''
  }
}

function toUuid(id) {
  if (!id || id.includes('-')) return id
  return id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
}
