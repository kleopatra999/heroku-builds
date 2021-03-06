'use strict'

let cli = require('heroku-cli-util')
let fs = require('fs')
let uuid = require('node-uuid')
let os = require('os')
let path = require('path')
let exec = require('child_process').execSync
let nodeTar = require('../../lib/node_tar')

function compressSource (context, cwd, tempFile, cb) {
  var tar = context.flags['tar'] || 'tar'
  let tarVersion = exec(tar + ' --version').toString()

  if (tarVersion.match(/GNU tar/)) {
    let includeVcsIgnore = context.flags['include-vcs-ignore']
    let command = tar + ' cz -C ' + cwd + ' --exclude .git --exclude .gitmodules .'

    if (!includeVcsIgnore) {
      command += ' --exclude-vcs-ignores'
    }

    exec(command + ' > ' + tempFile)
    cb()
  } else {
    cli.warn('Couldn\'t detect GNU tar. Builds could fail due to decompression errors')
    cli.warn('See https://devcenter.heroku.com/articles/platform-api-deploying-slugs#create-slug-archive')
    cli.warn('Please install it, or specify the \'--tar\' option')
    cli.warn('Falling back to node\'s built-in compressor')
    nodeTar.call(cwd, tempFile, cb)
  }
}

function uploadCwdToSource (context, heroku, cwd, fn) {
  let tempFilePath = path.join(os.tmpdir(), uuid.v4() + '.tar.gz')

  heroku.request({
    method: 'POST',
    path: '/sources'
  }).then(function (source) {
    compressSource(context, cwd, tempFilePath, function () {
      var stream = fs.createReadStream(tempFilePath)
      stream.on('close', function () {
        fs.unlink(tempFilePath)
      })

      cli.got.put(source.source_blob.put_url, {
        body: stream,
        headers: {
          'Content-Type': '',
          'Content-Length': fs.statSync(tempFilePath).size
        }
      })
        .then(function () {
          fn(source.source_blob.get_url)
        })
    })
  })
}

function create (context, heroku) {
  var sourceUrl = context.flags['source-url']

  var sourceUrlPromise = sourceUrl
    ? new Promise(function (resolve) { resolve(sourceUrl) })
    : new Promise(function (resolve) { uploadCwdToSource(context, heroku, process.cwd(), resolve) })

  return sourceUrlPromise.then(function (sourceGetUrl) {
    return heroku.request({
      method: 'POST',
      path: `/apps/${context.app}/builds`,
      body: {
        source_blob: {
          url: sourceGetUrl,
          // TODO provide better default, eg. archive md5
          version: context.flags.version || ''
        }
      }
    })
  })
  .then(function (build) {
    return new Promise(function (resolve, reject) {
      let stream = cli.got.stream(build.output_stream_url)
      stream.on('error', reject)
      stream.on('end', resolve)
      let piped = stream.pipe(process.stderr)
      piped.on('error', reject)
    })
  })
}

module.exports = {
  topic: 'builds',
  command: 'create',
  needsAuth: true,
  needsApp: true,
  help: 'Create build from contents of current dir',
  description: 'create build',
  flags: [
    { name: 'source-url', description: 'source URL that points to the tarball of your application\'s source code', hasValue: true },
    { name: 'tar', description: 'path to the executable GNU tar', hasValue: true },
    { name: 'version', description: 'description of your new build', hasValue: true },
    { name: 'include-vcs-ignore', description: 'include files ignores by VCS (.gitignore, ...) from the build' }
  ],
  run: cli.command(create)
}
