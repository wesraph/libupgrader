const slsk = require('slsk-client')
const mm = require('music-metadata');
const recdir = require('recursive-readdir');
const readline = require('readline')
const fs = require('fs')

if(process.argv.length < 3) {
  console.log("Usage: node server.js pathToLibrary")
  process.exit(1)
}

var libraryPath = process.argv[2]
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
var downloadingCount = 0
var creds = JSON.parse(fs.readFileSync("creds.json").toString())
try {
  fs.mkdirSync("./downloads")

} catch(err) {
  if(err.code != 'EEXIST') {
    console.log(err)
    process.exit(1)
  }
}
async function main() {
  console.log("Login to soulseek")
  var sclient = await new Promise(function(resolve, reject){
    slsk.connect({
      user: creds.user,
      pass: creds.pass
    }, (err, client) => {
      if(typeof(err) !== 'undefined' && err) {
        reject(err)
      }
      resolve(client)
    })
  }).catch((err) => {
    console.log(err)
    return
  })
  console.log("OK")

  console.log('Building library path cache')
  var libraryFiles = await new Promise(function(resolve, reject) {
    recdir(libraryPath, function (err, files) {
      if(err) {
        reject(err)
      }
      resolve(files)
    });
  })

  libraryFiles = libraryFiles.filter(file => regIsSongFile.test(file))

  console.log("Getting metadata")
  var library = []
  for(var i in libraryFiles) {
    try{
    let bitrate = await new Promise((resolve, reject) => {
      mm.parseFile(libraryFiles[i]).then( (metadata) => {
        resolve(metadata.format.bitrate)
      }).catch((err) => {
        reject(err.message);
      });
    })

    library.push(
      {
        url: libraryFiles[i],
        bitrate: bitrate
      }
    )
    } catch(err){
      console.log(err)
    }
  }

  var totCum = 0
  let averageBitrate = library.reduce((accumulator, currentValue) =>{
    if(currentValue.bitrate !== undefined){
      totCum++
      return currentValue.bitrate + accumulator
    }
    return accumulator
  } , 0)
  averageBitrate = averageBitrate / totCum / 1000
  console.log("Average bitrate of library: " + averageBitrate)

  library = library.map((el) => {
    if(el.bitrate === undefined) {
      el.bitrate = 0
    }
    return el
  })


  // Smallest bitrate first
  library = library.sort((a,b) => {
    if(a.bitrate > b.bitrate) {
      return 1
    }
    return -1
  })

  let libraryLength = library.length
  for(var item  = 0; item < libraryLength; item++) {
    var orSong = library[item].url
    var ret = orSong.match(regSong)
    if(!ret || ret.length != 4) {
      continue
    }

    var artist = ret[1].replace(regArtist, '').toLowerCase()
    var title = ret[2].replace(regTitle, '').toLowerCase()

    var request = artist + " " + title
    console.log("Requesting " + request)
    var retsearch = await search(sclient, request).catch( (err) => {
      console.log(err)
    })
    if(!retsearch) {
      console.log("No results found")
      continue
    }

    console.log("Found " + retsearch.length + " results")

    var sortedItems = retsearch.sort(function(a,b) {
      if(a.bitrate < b.bitrate) {
        return 1
      }
      return -1
    })

    var filteredItems = []
    var minSpeed = 100
    // TODO: Replace with filter
    for(let sitem in sortedItems) {
      let song  = sortedItems[sitem]
      if( song.speed >= minSpeed &&
        song.slots == true &&
        song.bitrate > library[item].bitrate / 1000)
        //song.file.toLowerCase().includes(artist.toLowerCase()))
      {

        filteredItems.push(song)
      }
    }
    console.log("Total filtered items: " + filteredItems.length)
    if(filteredItems.length == 0) {
      console.log("No matching result")
      continue
    }

    let i = 1
    let toDisplay = 3
    let action
    do {
      console.log("Original name: " + orSong)
      console.log("Original bitrate: " + Math.round(library[item].bitrate / 1000))

      console.log(filteredItems.slice((i - 1) * toDisplay, i * toDisplay - 1))
      action = await question(
        "Which song to download ? (1 - "
        + toDisplay +
        " to choose, 0 to skip, n for next, p for previous, r rewrite request, q to quit): "
      )
      if(action === "n") {
        i++
      } else if(action === "p") {
        i--
      } else if(action === "r") {
        request = await question("New request: ")
      }

    } while(!(action <= toDisplay && action >= 0 || action === "q") &&
      (i * toDisplay < filteredItems.length))

    // If it's a download action
    if(action <= 3 && action >= 1) {
      action = action - 1
      downloadReplacer(orSong, filteredItems[action + toDisplay * (i -1)], sclient)
    } else if(action === "q"){
      console.log("Quitting search")
      break
    }

  }

  setInterval(() => {
    if(downloadingCount == 0) {
      console.log("All downloads are done, quitting")
      process.exit(0)
    }
    console.log("Remaining downloads: " + downloadingCount)
  }, 2000)
  return

}

async function downloadReplacer(originalPath, replacer, sclient) {
  let originalFilename = originalPath.split("/")
  originalFilename = originalFilename[originalFilename.length - 1]

  let outputFilename = replacer.file.split('\\')
  outputFilename = outputFilename[outputFilename.length - 1]
  let extensionInput = originalFilename.match(regIsSongFile)

  let extensionOutput = outputFilename.match(regIsSongFile)
  if(extensionOutput === null) {
    console.log("Cannot find extension of downloading file: "+ outputFilename)
    return
  }

  let outputFilenameInLibrary = originalFilename.replace(extensionInput, extensionOutput)

  downloadingCount++
  try{
  await new Promise((resolve, reject) =>{
    sclient.download({
      file: replacer,
      path: "downloads/"+outputFilename
    }, (err, data) => {
      if(err) {
        reject(err)
      }
      resolve(data)
    })
  })
  } catch(err) {
    console.log("Failed to download " + originalFilename)
    downloadingCount--
    return
  }

  downloadingCount--

  fs.unlinkSync(originalPath)

  let destFolder = originalPath.split("/").slice(0, -1).join("/")
  fs.copyFileSync(
    "downloads/" + outputFilename,
    destFolder + "/" + outputFilenameInLibrary
  )

  fs.unlinkSync("downloads/" + outputFilename)

  console.log("Done downloading " + outputFilename)
  console.log("Still downloading: " + downloadingCount)
}

function question(ask){
  return new Promise(function(resolve) {
    rl.question(ask, (answer) => {
      resolve(answer)
    });
  })
}

function search(sclient, request) {
  return new Promise((resolve, reject) => {
    sclient.search({
      req: request,
    }, (err, res) => {
      if(err) {
        reject(err)
        return
      }
      resolve(res)
    })
  })
}
main()

var regIsSongFile = /\.(mp3|flac|wav)$/
var regSong = /^(.*?)-(.*?)\.(mp3|flac|wav)/
var regArtist = /^.*\//g
var regTitle = /\(.*?\)|\[.*?\]/g
