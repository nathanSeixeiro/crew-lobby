// Zero-dependency preview server for Crew Lobby. Binds to 127.0.0.1 only.
//   node preview/server.mjs            -> http://127.0.0.1:5480/
//   PORT=5490 node preview/server.mjs  -> another port
// Serves this folder at / and ../app/ui at /app/. Nothing else, no writes.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const PORT = Number(process.env.PORT) || 5480
const here = fileURLToPath(new URL('.', import.meta.url))
const ROOTS = [
  ['/app/', resolve(here, '..', 'app', 'ui')],
  ['/', resolve(here)],
]
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}
const SERVED = new Set(['/index.html', '/mock-sdk.mjs', '/mock-data.mjs', '/shell.mjs'])

function resolveFile(pathname) {
  for (const [prefix, root] of ROOTS) {
    if (!pathname.startsWith(prefix)) continue
    if (prefix === '/' && !SERVED.has(pathname)) return null
    const file = resolve(root, pathname.slice(prefix.length))
    return file.startsWith(root + sep) && TYPES[extname(file)] ? file : null
  }
  return null
}

createServer(async (req, res) => {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', `http://${HOST}`).pathname)
  } catch {
    res.writeHead(400).end('bad request')
    return
  }
  if (pathname === '/') pathname = '/index.html'
  const file = req.method === 'GET' ? resolveFile(pathname) : null
  if (!file) {
    res.writeHead(404).end('not found')
    return
  }
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)], 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, HOST, () => {
  console.log(`Crew Lobby preview: http://${HOST}:${PORT}/   (?lang=en  ?theme=light)`)
})
