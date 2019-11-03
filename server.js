const slsk = require('slsk-client')
const mm = require('music-metadata');
const recdir = require('recursive-readdir');
const readline = require('readline')
const fs = require('fs')
const colors = require('colors');

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
  console.log(colors.grey("Login to soulseek"))
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
  console.log(colors.grey("OK"))

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

  console.log(colors.grey("Getting metadata"))
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
  var stats = {
    "128orLess": 0,
    "128to256": 0,
    "moreThan256": 0
  }
  let averageBitrate = library.reduce((accumulator, currentValue) =>{
    if(currentValue.bitrate !== undefined){
      if(currentValue.bitrate <= 128000) {
        stats["128orLess"]++
      } else if(
        currentValue.bitrate > 128000
        && currentValue.bitrate < 256000
      ) { stats["128to256"]++ } else {
        stats["moreThan256"]++
      }

      totCum++
      return currentValue.bitrate + accumulator
    }
    return accumulator
  } , 0)
  averageBitrate = averageBitrate / totCum / 1000
  console.log("Average bitrate of library: " + Math.round(averageBitrate) + "kbps")
  let statSum = stats["128orLess"] + stats["moreThan256"] + stats["128to256"]
  stats["128orLess"] = (stats["128orLess"] / statSum) * 100
  stats["128to256"] = (stats["128to256"] / statSum) * 100
  stats["moreThan256"] = (stats["moreThan256"] / statSum) * 100
  console.log("Statistics: \n" +
    "<= 128kbps:         " + colors.red(stats["128orLess"] + "%\n") +
    "[128kbps; 256kbps]: " + colors.blue(stats["128to256"] + "%\n") +
    "> 256kbps:          " + colors.green(stats["moreThan256"] + "%\n"))

  library = library.map((el) => {
    if(el.bitrate === undefined) {
      el.bitrate = 0
    }
    return el
  })


  // TODO: Remove this
  library = library.filter(file => file.bitrate != 0)

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
    console.log("Requesting: " + request)

    let results = await search(request, library[item], sclient)

    let i = 1
    let toDisplay = 3
    let action
    do {
      console.log("Original name: " + orSong)
      console.log("Original bitrate: " + Math.round(library[item].bitrate / 1000))

      if(results.length > 0 && (i - 1) * toDisplay < results.length) {
        console.log(
          results.slice(
            (i - 1) * toDisplay,
            Math.min(i * toDisplay - 1, results.length
            )
          )
        )
      } else {
        console.log(colors.red("No results"))
      }

      action = await question(
        colors.green("Which song to download ? (1 - "
        + toDisplay +
        " to choose, 0 to skip, n for next, p for previous, r rewrite request, q to quit): "
      ))
      if(action === "n") {
        i++
      } else if(action === "p") {
        i--
      } else if(action === "r") {
        request = await question(colors.green("New request: "))
        results = await search(request, library[item], sclient)
        i = 1
      } else if(action <= toDisplay && action >= 0) {
        break
      }

    } while(action !== "q")

    // If it's a download action
    if(action <= 3 && action >= 1) {
      console.log("Downloading new song")
      action = action - 1
      downloadReplacer(orSong, results[action + toDisplay * (i -1)], sclient)
    } else if(action === "q"){
      console.log("Quitting search")
      break
    }

    process.stdout.write('\x1B[2J\x1B[0f');

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

async function search(request, initialSong, sclient){
  var retsearch = await searchOnSoulseek(sclient, request).catch( (err) => {
    console.log(err)
  })
  if(!retsearch) {
    console.log(colors.red("No results found"))
    return []
  }

  console.log("Results: " + colors.green(retsearch.length))

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
      song.bitrate > initialSong.bitrate / 1000)
      //song.file.toLowerCase().includes(artist.toLowerCase()))
    {

      filteredItems.push(song)
    }
  }
  console.log("Filtered results: " + filteredItems.length)

  return filteredItems
}

async function searchOnSoulseek(sclient, request) {
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
