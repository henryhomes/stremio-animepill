
const redis = require('redis').createClient({
  host: 'redis-11879.c10.us-east-1-4.ec2.cloud.redislabs.com',
  port: 11879,
  password: process.env.REDIS_PASS
})

redis.on('error', err => { console.error('Redis error', err) })

const mapToAp = {}
const streams = {}

function toJson(str) {
	let resp
	try {
		resp = JSON.parse(str)
	} catch(e) {
		console.error('Redis parse error', e)
	}
	return resp
}

module.exports = {
	map: {
		get: (kitsuId, cb) => {
			if (!kitsuId) cb()
			else {
				if (mapToAp[kitsuId]) cb(mapToAp[kitsuId])
				else
					redis.get('kitsu-apill-' + kitsuId, (err, redisRes) => {
						if (!err && redisRes) {
							const redisSlugs = toJson(redisRes)
							if (redisSlugs) {
								cb(redisSlugs)
								return
							}
						}
						cb()
					})
			}
		},
		set: (kitsuId, data) => {
			if (!mapToAp[kitsuId] || (mapToAp[kitsuId].length > 1 && data.length == 1)) {
				mapToAp[kitsuId] = data
				redis.set('kitsu-apill-' + kitsuId, JSON.stringify(data))
			}
		}
	},
	get: (key, cb) => {

		if (streams[key]) {
			cb(streams[key])
			return
		}

		redis.get(key, (err, redisRes) => {

			if (!err && redisRes) {
				const redisStreams = toJson(redisRes)
				if (redisStreams) {
					cb(redisStreams)
					return
				}
			}
			cb()
		})

	},
	set: (key, data, age) => {
		// cache forever
		streams[key] = data
		redis.setex(key, age, JSON.stringify(data))
	},
	catalog: {
		set: (key, page, data) => {
			if (!key) return
			const redisKey = 'apill-catalog-' + key + (page > 1 ? ('-' + page) : '')
			redis.setex(redisKey, 604800, JSON.stringify(data))
		},
		get: (key, page, cb) => {
			if (!key) {
				cb()
				return
			}
			const redisKey = 'apill-catalog-' + key + (page > 1 ? ('-' + page) : '')
			redis.get(redisKey, (err, redisRes) => {

				if (!err && redisRes) {
					const redisCatalog = toJson(redisRes)
					if (redisCatalog) {
						cb(redisCatalog)
						return
					}
				}
				cb()
			})
		}
	}
}