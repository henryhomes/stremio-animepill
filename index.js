const needle = require('needle')
const async = require('async')
const cheerio = require('cheerio')
const namedQueue = require('named-queue')
const db = require('./lib/cache')

const package = require('./package')

const manifest = {
    id: 'org.animepill.anime',
    version: package.version,
    logo: 'https://cdn11.bigcommerce.com/s-sq9zkarfah/images/stencil/1280x1280/products/77018/174753/Akira-Pill-Anime-Decal-Sticker__92133.1511144802.jpg?c=2&imbypass=on',
    name: 'Anime from AnimePill',
    description: 'Anime from AnimePill',
    resources: ['catalog', 'meta', 'stream'],
    types: ['series', 'movie'],
    idPrefixes: ['kitsu:'],
    catalogs: [
      {
        type: 'series',
        id: 'animepill-search',
        name: 'AnimePill',
        extra: [
          {
            name: 'search',
            isRequired: true
          }
        ]
      }, {
        type: 'movie',
        id: 'animepill-search',
        name: 'AnimePill',
        extra: [
          {
            name: 'search',
            isRequired: true
          }
        ]
      }
    ]
}

const { addonBuilder, serveHTTP, publishToCentral }  = require('stremio-addon-sdk')

const addon = new addonBuilder(manifest)

const endpoint = 'http://animepill.com/'

const headers = {
  'Accept': '*/*',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'Content-Type': 'application/json',
  'Host': 'animepill.com',
  'Referer': 'http://animepill.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36'
}

const mapToKitsu = {}
const mapToPoster = {}

const cache = {
  catalog: {}
}

function toMeta(kitsuId, obj) {
  const newObj = JSON.parse(JSON.stringify(obj))
  newObj.id = mapToKitsu[kitsuId]
  newObj.poster = mapToPoster[kitsuId]
  newObj.type = 'series'
  return newObj
}

function toSlug(url) {
  const urlParts = url.split('/')
  return urlParts[urlParts.length -1]
}

const searchQueue = new namedQueue((args, cb) => {
  needle.get(endpoint + 'api/animes?s=' + encodeURIComponent(args.id), { headers }, cb)
}, Infinity)

addon.defineCatalogHandler(args => {
  return new Promise((resolve, reject) => {

    const page = 1

    const redisKey = args.type + '-' + args.extra.search

    if (cache.catalog[redisKey]) {
      if (cache.catalog[redisKey])
        resolve({ metas: cache.catalog[redisKey], cacheMaxAge: 1209600 }) // cache 14 days
      else
        reject('No results for: ' + args.type + ' ' + args.extra.search)
      return
    }

    function getKitsu(suggestMetas, responded) {
        if (suggestMetas.length) {
          const metas = []
          const queue = async.queue((task, cb) => {
            if (mapToKitsu[task.name]) {
              metas.push(toMeta(task.name, task))
              cb()
              return
            }
            const type = task.type
            function searchKitsu(query, callback) {
              needle.get(kitsuEndpoint + '/catalog/' + type + '/kitsu-search-' + type + '/search=' + encodeURIComponent(query) + '.json', (err, resp, body) => {
                const kitsuMetas = (body || {}).metas || []
                let meta
                if (kitsuMetas.length) {
                  if (task.releaseInfo) {
                    const found = kitsuMetas.some(el => {
                      if (el.releaseInfo && el.releaseInfo.startsWith(task.releaseInfo)) {
                        meta = el
                        return true
                      }
                    })
                  }
                  if (!meta)
                    meta = kitsuMetas[0]
                  db.map.set(meta.id, toSlug(task.href))
                  mapToKitsu[task.name] = meta.id
                  mapToPoster[task.name] = meta.poster
                  meta.type = 'series'
                  metas.push(meta)
                }
                callback(!!meta)
              })
            }
            searchKitsu(task.name, success => {
              if (!success && task.name.toLowerCase().endsWith('season')) {
                let altQuery = task.name.split(' ')
                altQuery.splice(-1,1)
                altQuery[altQuery.length -1] = parseInt(altQuery[altQuery.length -1])
                searchKitsu(altQuery.join(' '), () => {
                  cb()
                })
              } else
                cb()
            })
          }, 1)
          queue.drain = () => {
            cache.catalog[redisKey] = metas
            // cache for 1 day (search)
            setTimeout(() => {
              delete cache.catalog[redisKey]
            }, 86400000)
            if (metas.length && redisKey)
              db.catalog.set(redisKey, page, metas)
            if (!responded) {
              if (metas.length)
                resolve({ metas, cacheMaxAge: 1209600 })
              else
                reject(new Error('No results for: ' + args.type + ' ' + args.extra.search))
            }
          }
          suggestMetas.forEach(el => { queue.push(el) })
        } else if (!responded)
          reject('Meta error 3: ' + args.id)
    }

    function reqCb(err, resp, body, cb) {
      if (!err && body) {
        const $ = cheerio.load(body)
        const results = []
        $('.dropdown-results a.items-center').each((ij, el) => {
          results.push({
            href: $(el).attr('href'),
            name: $(el).find('span.font-bold').text(),
            type: args.type
          })
        })
        if (results.length) {
          getKitsu(results)
        } else {
          reject('Unable to get search results for: ' + args.extra.search)
        }
      }
    }

    db.catalog.get(redisKey, 1, redisMetas => {

      if (redisMetas)
        resolve({ metas: redisMetas, cacheMaxAge: 1209600 }) // 2 weeks

      let allResults = []

      searchQueue.push({ id: args.extra.search }, (err, resp, body) => {
        reqCb(err, resp, body, suggestMetas => {
          if (suggestMetas.length) {
            allResults = allResults.concat(suggestMetas)
            callback(allResults, !!redisMetas)
          } else {
            reject('No results for search: ' + args.extra.search)
          }
        })
      })

    })
  })
})

const kitsuEndpoint = 'https://addon.stremio-kitsu.cf'

addon.defineMetaHandler(args => {
  return new Promise((resolve, reject) => {
    needle.get(kitsuEndpoint + '/meta/' + args.type + '/' + args.id + '.json', (err, resp, body) => {
      if (body && body.meta)
        resolve(body)
      else
        reject(new Error('Could not get meta from kitsu api for: '+args.id))
    })
  })
})

addon.defineStreamHandler(args => {
  return new Promise((resolve, reject) => {
    const id = args.id
    const cacheMaxAge = 600
    db.get('apill-s-'+id, cached => {
      if (cached) {
        const streams = []
        cached.forEach(el => {
          streams.push({ title: el.title + '\nExternal', externalUrl: el.url })
          if (el.url.includes('mp4upload.com'))
            streams.push({ title: el.title + '\nStream', url: 'https://extract.stremio-kitsu.cf/?url=' + encodeURIComponent(el.url) })
        })
        resolve({ streams, cacheMaxAge })
        return
      }
      const idParts = id.split(':')
      const kitsuId = 'kitsu:' + idParts[1]
      const episode = idParts.length > 2 ? idParts[idParts.length -1] : 1
      db.map.get(kitsuId, apSlug => {
        if (apSlug) {
          const apHeaders = JSON.parse(JSON.stringify(headers))
          delete apHeaders['Content-Type']
          needle.get(endpoint + apSlug + '-episode-' + episode, { headers: apHeaders }, (err, resp, body) => {
            if (!err && body) {
              const $ = cheerio.load(body)
              const streams = []
              const cacheStreams = []
              $($('.js-mirrors')[0]).find('.text-sm').each((ij, el) => {
                const streamTitle = $(el).text().replace(/(\r\n|\n|\r)/gm, '')
                const streamUrl = $(el).attr('data-src')
                streams.push({ title: streamTitle + '\nExternal', externalUrl: streamUrl })
                cacheStreams.push({ title: streamTitle, url: streamUrl })
                if (streamUrl.includes('mp4upload.com'))
                  streams.push({ title: streamTitle + '\nStream', url: 'https://extract.stremio-kitsu.cf/?url=' + encodeURIComponent(streamUrl) })
              })
              if (cacheStreams.length) {
                db.set('apill-s-'+id, cacheStreams, 1209600) // 14 days
                resolve({ streams, cacheMaxAge }) // 10 minutes
              } else 
                reject('No streams for: ' + id)
            } else 
              reject('Could not parse html for: ' + id)
          })
        } else 
          reject('Could not get streams for: ' + id)
      })
    })
  })
})

module.exports = addon.getInterface()
