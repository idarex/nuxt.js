'use strict'

const debug = require('debug')('nuxt:build')
debug.color = 2 // force green color
const _ = require('lodash')
const co = require('co')
const chokidar = require('chokidar')
const fs = require('fs-extra')
const hash = require('hash-sum')
const pify = require('pify')
const webpack = require('webpack')
const { createBundleRenderer } = require('vue-server-renderer')
const { join, resolve, sep } = require('path')
const clientWebpackConfig = require('./webpack/client.config.js')
const serverWebpackConfig = require('./webpack/server.config.js')
const remove = pify(fs.remove)
const readFile = pify(fs.readFile)
const writeFile = pify(fs.writeFile)
const mkdirp = pify(fs.mkdirp)
const glob = pify(require('glob'))
const reqSep = /\//g
const sysSep = _.escapeRegExp(sep)
const normalize = string => string.replace(reqSep, sysSep)
const wp = function (p) {
  /* istanbul ignore if */
  if (/^win/.test(process.platform)) {
    p = p.replace(/\\/g, '\\\\')
  }
  return p
}
const r = function () {
  let args = Array.from(arguments)
  if (_.last(args).includes('~')) {
    return wp(_.last(args))
  }
  args = args.map(normalize)
  return wp(resolve.apply(null, args))
}

const defaults = {
  filenames: {
    css: 'style.css',
    vendor: 'vendor.bundle.js',
    app: 'nuxt.bundle.js'
  },
  vendor: [],
  loaders: [],
  plugins: [],
  babel: {},
  postcss: []
}
const defaultsLoaders = [
  {
    test: /\.(png|jpe?g|gif|svg)$/,
    loader: 'url-loader',
    query: {
      limit: 1000, // 1KO
      name: 'img/[name].[ext]?[hash]'
    }
  },
  {
    test: /\.(woff2?|eot|ttf|otf)(\?.*)?$/,
    loader: 'url-loader',
    query: {
      limit: 1000, // 1 KO
      name: 'fonts/[name].[hash:7].[ext]'
    }
  }
]
const defaultsPostcss = [
  require('autoprefixer')({
    browsers: ['last 3 versions']
  })
]

exports.options = function () {
  // Defaults build options
  let extraDefaults = {}
  if (this.options.build && !Array.isArray(this.options.build.loaders)) extraDefaults.loaders = defaultsLoaders
  if (this.options.build && !Array.isArray(this.options.build.postcss)) extraDefaults.postcss = defaultsPostcss
  this.options.build = _.defaultsDeep(this.options.build, defaults, extraDefaults)
  // Production, create server-renderer
  if (!this.dev) {
    const serverConfig = getWebpackServerConfig.call(this)

    const bundlePath = process.env.serverFile ||
      join(serverConfig.output.path, serverConfig.output.filename)

    if (fs.existsSync(bundlePath)) {
      const bundle = fs.readFileSync(bundlePath, 'utf8')
      createRenderer.call(this, bundle)
    }
  }
}

exports.build = function * () {
  // Check if pages dir exists and warn if not
  if (!fs.existsSync(join(this.srcDir, 'pages'))) {
    if (fs.existsSync(join(this.srcDir, '..', 'pages'))) {
      console.error('> No `pages` directory found. Did you mean to run `nuxt` in the parent (`../`) directory?')  // eslint-disable-line no-console
    } else {
      console.error('> Couldn\'t find a `pages` directory. Please create one under the project root') // eslint-disable-line no-console
    }
    process.exit(1)
  }
  debug(`App root: ${this.srcDir}`)
  debug('Generating .nuxt/ files...')
  // Create .nuxt/, .nuxt/components and .nuxt/dist folders
  yield remove(r(this.dir, '.nuxt'))
  yield mkdirp(r(this.dir, '.nuxt/components'))
  if (!this.dev) {
    yield mkdirp(r(this.dir, '.nuxt/dist'))
  }
  // Generate routes and interpret the template files
  yield generateRoutesAndFiles.call(this)
  // Generate .nuxt/dist/ files
  yield buildFiles.call(this)
  return this
}

function * buildFiles () {
  if (this.dev) {
    debug('Adding webpack middlewares...')
    createWebpackMiddlewares.call(this)
    webpackWatchAndUpdate.call(this)
    watchPages.call(this)
  } else {
    debug('Building files...')
    yield [
      webpackRunClient.call(this),
      webpackRunServer.call(this)
    ]
  }
}

function * generateRoutesAndFiles () {
  debug('Generating routes...')
  // Layouts
  let layouts = {}
  const layoutsFiles = yield glob('layouts/*.vue', { cwd: this.srcDir })
  layoutsFiles.forEach((file) => {
    let name = file.split('/').slice(-1)[0].replace('.vue', '')
    if (name === 'error') return
    layouts[name] = r(this.srcDir, file)
  })
  // Generate routes based on files
  const files = yield glob('pages/**/*.vue', { cwd: this.srcDir })
  this.routes = _.uniq(_.map(files, (file) => {
    return file.replace(/^pages/, '').replace(/\.vue$/, '').replace(/\/index/g, '').replace(/_/g, ':').replace('', '/').replace(/\/{2,}/g, '/')
  }))
  // Interpret and move template files to .nuxt/
  debug('Generating files...')
  let templatesFiles = [
    'App.vue',
    'client.js',
    'index.js',
    'router.js',
    'server.js',
    'utils.js',
    'components/nuxt-loading.vue',
    'components/nuxt-child.js',
    'components/nuxt-link.js',
    'components/nuxt.vue'
  ]
  let templateVars = {
    uniqBy: _.uniqBy,
    isDev: this.dev,
    router: {
      base: this.options.router.base,
      linkActiveClass: this.options.router.linkActiveClass
    },
    env: this.options.env,
    head: this.options.head,
    store: this.options.store,
    css: this.options.css,
    plugins: this.options.plugins.map((p) => r(this.srcDir, p)),
    appPath: './App.vue',
    layouts: layouts,
    loading: (typeof this.options.loading === 'string' ? r(this.srcDir, this.options.loading) : this.options.loading),
    transition: this.options.transition,
    components: {
      Loading: r(__dirname, 'app', 'components', 'nuxt-loading.vue'),
      ErrorPage: r(__dirname, 'app', 'components', 'nuxt-error.vue')
    }
  }
  // Format routes for the lib/app/router.js template
  templateVars.router.routes = createRoutes(files, this.srcDir)
  if (layoutsFiles.includes('layouts/error.vue')) {
    templateVars.components.ErrorPage = r(this.srcDir, 'layouts/error.vue')
  }
  // If no default layout, create its folder and add the default folder
  if (!layouts.default) {
    yield mkdirp(r(this.dir, '.nuxt/layouts'))
    templatesFiles.push('layouts/default.vue')
    layouts.default = r(__dirname, 'app', 'layouts', 'default.vue')
  }
  let moveTemplates = templatesFiles.map((file) => {
    return readFile(r(__dirname, 'app', file), 'utf8')
    .then((fileContent) => {
      const template = _.template(fileContent)
      const content = template(templateVars)
      return writeFile(r(this.dir, '.nuxt', file), content, 'utf8')
    })
  })
  yield moveTemplates
}

function createRoutes (files, srcDir) {
  let routes = []
  files.forEach((file) => {
    let keys = file.replace(/^pages/, '').replace(/\.vue$/, '').replace(/\/{2,}/g, '/').split('/').slice(1)
    let route = { name: '', path: '', component: r(srcDir, file), _name: null }
    let parent = routes
    keys.forEach((key, i) => {
      route.name = route.name ? route.name + '-' + key.replace('_', '') : key.replace('_', '')
      let child = _.find(parent, { name: route.name })
      if (child) {
        if (!child.children) {
          child.children = []
        }
        parent = child.children
        route.path = ''
      } else {
        if (key === 'index' && (i + 1) === keys.length) {
          route.path += (i > 0 ? '' : '/')
        } else {
          route.path += '/' + key.replace('_', ':')
          if (key.includes('_')) {
            route.path += '?'
          }
        }
      }
    })
    route._name = '_' + hash(route.component)
    // Order Routes path
    parent.push(route)
    parent.sort((a, b) => {
      var isA = (a.path[0] === ':' || a.path[1] === ':') ? 1 : 0
      var isB = (b.path[0] === ':' || b.path[1] === ':') ? 1 : 0
      return (isA - isB === 0) ? a.path.length - b.path.length : isA - isB
    })
  })
  return cleanChildrenRoutes(routes)
}

function cleanChildrenRoutes (routes, isChild = false) {
  let hasIndex = false
  let parents = []
  routes.forEach((route) => {
    route.path = (isChild) ? route.path.replace('/', '') : route.path
    if ((isChild && /-index$/.test(route.name)) || (!isChild && route.name === 'index')) {
      hasIndex = true
    }
    route.path = (hasIndex) ? route.path.replace('?', '') : route.path
    if (/-index$/.test(route.name)) {
      parents.push(route.name)
    } else {
      if (parents.indexOf(route.name.split('-').slice(0, -1).join('-') + '-index') > -1) {
        route.path = route.path.replace('?', '')
      }
    }
    route.name = route.name.replace(/-index$/, '')
    if (route.children) {
      delete route.name
      route.children = cleanChildrenRoutes(route.children, true)
    }
  })
  return routes
}

function getWebpackClientConfig () {
  return clientWebpackConfig.call(this)
}

function getWebpackServerConfig () {
  return serverWebpackConfig.call(this)
}

function createWebpackMiddlewares () {
  const clientConfig = getWebpackClientConfig.call(this)
  // setup on the fly compilation + hot-reload
  clientConfig.entry.app = _.flatten(['webpack-hot-middleware/client?reload=true', clientConfig.entry.app])
  clientConfig.plugins.push(
    new webpack.HotModuleReplacementPlugin(),
    new webpack.NoErrorsPlugin()
  )
  const clientCompiler = webpack(clientConfig)
  // Add the middlewares to the instance context
  this.webpackDevMiddleware = pify(require('webpack-dev-middleware')(clientCompiler, {
    publicPath: clientConfig.output.publicPath,
    stats: {
      colors: true,
      chunks: false
    },
    quiet: false,
    noInfo: true
  }))
  this.webpackHotMiddleware = pify(require('webpack-hot-middleware')(clientCompiler))
}

function webpackWatchAndUpdate () {
  const MFS = require('memory-fs') // <- dependencies of webpack
  const mfs = new MFS()
  const serverConfig = getWebpackServerConfig.call(this)
  const serverCompiler = webpack(serverConfig)
  const outputPath = join(serverConfig.output.path, serverConfig.output.filename)
  serverCompiler.outputFileSystem = mfs
  this.webpackServerWatcher = serverCompiler.watch({}, (err, stats) => {
    if (err) throw err
    stats = stats.toJson()
    stats.errors.forEach(err => console.error(err)) // eslint-disable-line no-console
    stats.warnings.forEach(err => console.warn(err)) // eslint-disable-line no-console
    createRenderer.call(this, mfs.readFileSync(outputPath, 'utf-8'))
  })
}

function webpackRunClient () {
  return new Promise((resolve, reject) => {
    const clientConfig = getWebpackClientConfig.call(this)
    const serverCompiler = webpack(clientConfig)
    serverCompiler.run((err, stats) => {
      if (err) return reject(err)
      console.log('[nuxt:build:client]\n', stats.toString({ chunks: false, colors: true })) // eslint-disable-line no-console
      resolve()
    })
  })
}

function webpackRunServer () {
  return new Promise((resolve, reject) => {
    const serverConfig = getWebpackServerConfig.call(this)
    const serverCompiler = webpack(serverConfig)
    serverCompiler.run((err, stats) => {
      if (err) return reject(err)
      console.log('[nuxt:build:server]\n', stats.toString({ chunks: false, colors: true })) // eslint-disable-line no-console
      const bundlePath = join(serverConfig.output.path, serverConfig.output.filename)
      readFile(bundlePath, 'utf8')
      .then((bundle) => {
        createRenderer.call(this, bundle)
        resolve()
      })
    })
  })
}

function createRenderer (bundle) {
  // Create bundle renderer to give a fresh context for every request
  let cacheConfig = false
  if (this.options.cache) {
    this.options.cache = (typeof this.options.cache !== 'object' ? {} : this.options.cache)
    cacheConfig = require('lru-cache')(_.defaults(this.options.cache, {
      max: 1000,
      maxAge: 1000 * 60 * 15
    }))
  }
  this.renderer = createBundleRenderer(bundle, {
    cache: cacheConfig
  })
  this.renderToString = pify(this.renderer.renderToString)
  this.renderToStream = this.renderer.renderToStream
}

function watchPages () {
  const patterns = [
    r(this.srcDir, 'pages'),
    r(this.srcDir, 'pages/*.vue'),
    r(this.srcDir, 'pages/**/*.vue'),
    r(this.srcDir, 'layouts'),
    r(this.srcDir, 'layouts/*.vue'),
    r(this.srcDir, 'layouts/**/*.vue')
  ]
  const options = {
    ignoreInitial: true
  }
  /* istanbul ignore next */
  const refreshFiles = _.debounce(() => {
    var d = Date.now()
    co(generateRoutesAndFiles.bind(this))
    .then(() => {
      console.log('Time to gen:' + (Date.now() - d) + 'ms') // eslint-disable-line no-console
    })
  }, 200)
  this.pagesFilesWatcher = chokidar.watch(patterns, options)
  .on('add', refreshFiles)
  .on('unlink', refreshFiles)
}
