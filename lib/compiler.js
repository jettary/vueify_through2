const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const hash = require('hash-sum')
const Emitter = require('events').EventEmitter
const vueCompiler = require('vue-template-compiler')
const sourceMap = require('source-map')
const convert = require('convert-source-map')

const genId = require('./gen-id')
const normalize = require('./normalize')
const compilers = require('./compilers')
const rewriteStyle = require('./style-rewriter')
const compileTemplate = require('./template-compiler')

// determine dynamic script paths
const hotReloadAPIPath = normalize.dep('vue-hot-reload-api')
const insertCSSPath = normalize.lib('insert-css')

let hasBabel = true
try {
  require('babel-core')
} catch (e) {
  hasBabel = false
}

const splitRE = /\r?\n/g
const resolvedPartsCache = Object.create(null)

// expose compiler
const compiler = module.exports = new Emitter()
compiler.setMaxListeners(Infinity)

// options
var options = compiler.options = {}

// load user config
compiler.loadConfig = () => {
  const fs = require('fs')
  const path = require('path')
  const configPath = path.resolve(process.cwd(), 'vue.config.js')
  if (fs.existsSync(configPath)) {
    compiler.applyConfig(require(configPath))
  }
}

// apply config
compiler.applyConfig = (config) => {
  // copy user options to default options
  Object.keys(config).forEach(function (key) {
    if (key !== 'customCompilers') {
      options[key] = config[key]
    } else {
      // register compilers
      Object.keys(config[key]).forEach(function (name) {
        compilers[name] = config[key][name]
      })
    }
  })
}

compiler.compile = async (content, filePath, cb) => {
  const isProduction = process.env.NODE_ENV === 'production'
  const isServer = process.env.VUE_ENV === 'server'
  const isTest = !!process.env.VUEIFY_TEST

  // generate css scope id
  const id = 'data-v-' + genId(filePath)
  // parse the component into parts
  const parts = vueCompiler.parseComponent(content, { pad: true })

  // check for scoped style nodes
  const hasScopedStyle = parts.styles.some((style) => !!style.scoped)

  const resolvedParts = {
    template: null,
    script: null,
    styles: []
  }

  Promise.all([
    processTemplate(parts.template, filePath, resolvedParts),
    processScript(parts.script, filePath, resolvedParts)
  ].concat(parts.styles.map((style) => processStyle(style, filePath, id, resolvedParts)))
  ).then(mergeParts)
    .catch(cb)

  async function mergeParts () {
    // check whether script/template has changed
    const prevParts = resolvedPartsCache[id] || {}
    resolvedPartsCache[id] = resolvedParts
    const scriptChanged = resolvedParts.script !== prevParts.script
    const templateChanged = resolvedParts.template !== prevParts.template

    let output = ''
    let map = null
    // styles
    let style = resolvedParts.styles.join('\n')
    if (style && !isServer) {
      // emit style
      compiler.emit('style', {
        file: filePath,
        style: style
      })
      if (!options.extractCSS) {
        style = JSON.stringify(style)
        output +=
          'var __vueify_style_dispose__ = require("' + insertCSSPath + '").insert(' + style + ')\n'
      }
    }
    // script
    const script = resolvedParts.script
    if (script) {
      if (options.sourceMap) {
        map = await generateSourceMap(script, output)
      }
      output +=
        ';(function(){\n' + script + '\n})()\n' +
        // babel 6 compat
        'if (module.exports.__esModule) module.exports = module.exports.default\n'
    }
    // in case the user exports with Vue.extend
    output += 'var __vue__options__ = (typeof module.exports === "function"' +
      '? module.exports.options' +
      ': module.exports)\n'
    // template
    const template = resolvedParts.template
    if (template) {
      if (!isProduction && !isServer) {
        output +=
          'if (__vue__options__.functional) {console.error("' +
          '[vueify] functional components are not supported and ' +
          'should be defined in plain js files using render functions.' +
          '")}\n'
      }
      let beforeLines
      if (map) {
        beforeLines = output.split(splitRE).length
      }
      output +=
        '__vue__options__.render = ' + template.render + '\n' +
        '__vue__options__.staticRenderFns = ' + template.staticRenderFns + '\n'
      if (map) {
        addTemplateMapping(content, parts, output, map, beforeLines)
      }
    }
    // scoped CSS id
    if (hasScopedStyle) {
      output += '__vue__options__._scopeId = "' + id + '"\n'
    }
    // hot reload
    if (!isProduction && !isTest && !isServer) {
      output +=
        'if (module.hot) {(function () {' +
        '  var hotAPI = require("' + hotReloadAPIPath + '")\n' +
        '  hotAPI.install(require("vue"), true)\n' +
        '  if (!hotAPI.compatible) return\n' +
        '  module.hot.accept()\n' +
        // remove style tag on dispose
        (style && !options.extractCSS
          ? '  module.hot.dispose(__vueify_style_dispose__)\n'
          : '') +
        '  if (!module.hot.data) {\n' +
        // initial insert
        '    hotAPI.createRecord("' + id + '", __vue__options__)\n' +
        '  } else {\n' +
        // update
        (scriptChanged
            ? '    hotAPI.reload("' + id + '", __vue__options__)\n'
            : templateChanged
              ? '    hotAPI.rerender("' + id + '", __vue__options__)\n'
              : ''
        ) +
        '  }\n' +
        '})()}'
    }
    if (map) {
      output += '\n' + convert.fromJSON(map.toString()).toComment()
    }
    cb(null, output)
  }

  async function generateSourceMap (script, output) {
    // hot-reload source map busting
    const hashedFilename = path.basename(filePath) + '?' + hash(filePath + content)
    const map = new sourceMap.SourceMapGenerator()
    map.setSourceContent(hashedFilename, content)
    // check input source map from babel/coffee etc
    const inMap = resolvedParts.map
    const inMapConsumer = inMap && await new sourceMap.SourceMapConsumer(inMap)
    const generatedOffset = (output ? output.split(splitRE).length : 0) + 1
    script.split(splitRE).forEach(function (line, index) {
      const ln = index + 1
      const originalLine = inMapConsumer
        ? inMapConsumer.originalPositionFor({ line: ln, column: 0 }).line
        : ln
      if (originalLine) {
        map.addMapping({
          source: hashedFilename,
          generated: {
            line: ln + generatedOffset,
            column: 0
          },
          original: {
            line: originalLine,
            column: 0
          }
        })
      }
    })
    map._hashedFilename = hashedFilename

    inMapConsumer.destroy()
    return map
  }
}

function addTemplateMapping (content, parts, output, map, beforeLines) {
  const afterLines = output.split(splitRE).length
  const templateLine = content.slice(0, parts.template.start).split(splitRE).length
  for (; beforeLines < afterLines; beforeLines++) {
    map.addMapping({
      source: map._hashedFilename,
      generated: {
        line: beforeLines,
        column: 0
      },
      original: {
        line: templateLine,
        column: 0
      }
    })
  }
}

function processTemplate (part, filePath, parts) {
  if (!part) return Promise.resolve()
  const template = getContent(part, filePath)
  return compileAsPromise('template', template, part.lang, filePath)
    .then(function (res) {
      parts.template = compileTemplate(res, compiler)
    })
}

function processScript (part, filePath, parts) {
  if (!part) return Promise.resolve()
  const lang = part.lang || (hasBabel ? 'babel' : null)
  const script = getContent(part, filePath)
  return compileAsPromise('script', script, lang, filePath)
    .then((res) => {
      if (typeof res === 'string') {
        parts.script = res
      } else {
        parts.script = res.code
        parts.map = res.map
      }
    })
}

function processStyle (part, filePath, id, parts) {
  const style = getContent(part, filePath)
  return compileAsPromise('style', style, part.lang, filePath)
    .then((res) => {
      res = res.trim()
      return rewriteStyle(id, res, part.scoped, options).then((res) => {
        parts.styles.push(res)
      })
    })
}

function getContent (part, filePath) {
  return part.src
    ? loadSrc(part.src, filePath)
    : part.content
}

function loadSrc (src, filePath) {
  const dir = path.dirname(filePath)
  const srcPath = path.resolve(dir, src)
  compiler.emit('dependency', srcPath)
  try {
    return fs.readFileSync(srcPath, 'utf-8')
  } catch (e) {
    console.error(chalk.red(`Failed to load src: "${src}" from file: "${filePath}"`))
  }
}

function compileAsPromise (type, source, lang, filePath) {
  const compile = compilers[lang]
  if (compile) {
    return new Promise((resolve, reject) => {
      compile(source, (err, res) => {
        if (err) {
          // report babel error codeframe
          if (err.codeFrame) {
            process.nextTick(() => {
              console.error(err.codeFrame)
            })
          }
          return reject(err)
        }
        resolve(res)
      }, compiler, filePath)
    })
  } else {
    return Promise.resolve(source)
  }
}
