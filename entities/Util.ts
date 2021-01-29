import axios from "axios"
import ffmpeg from "fluent-ffmpeg"
import * as util from "fluent-ffmpeg-util"
import fs from "fs"
import path from "path"
import {CrunchyrollAnime, CrunchyrollEpisode, CrunchyrollSeason, DownloadOptions, FFmpegProgress} from "../types"
import {Anime} from "./Anime"
import {Episode} from "./Episode"
export class Util {
    private static readonly parsem3u8 = (manifest: any) => {
      const m3u8Parser = require("m3u8-parser")
      const parser = new m3u8Parser.Parser()
      parser.push(manifest)
      parser.end()
      return parser.manifest
    }

    public static parseAnime = async (animeResolvable: string | CrunchyrollAnime | CrunchyrollSeason) => {
      let anime = null as unknown as CrunchyrollAnime
      if (animeResolvable.hasOwnProperty("series_id") && !animeResolvable.hasOwnProperty("collection_id")) {
          anime = animeResolvable as CrunchyrollAnime
      } else {
          const phrases = animeResolvable.hasOwnProperty("collection_id") ? (animeResolvable as CrunchyrollSeason).name.split(/ +/g) : (animeResolvable as string).split(/ +/g)
          while (!anime) {
              if (!phrases.length) return Promise.reject(`no anime found for ${animeResolvable}`)
              try {
                  anime = await Anime.get(phrases.join(" ")) as CrunchyrollAnime
              } catch {
                  phrases.pop()
              }
          }
      }
      return anime
    }

    public static downloadEpisode = async (episodeResolvable: string | CrunchyrollEpisode, dest?: string, options?: DownloadOptions, videoProgress?: (progress: FFmpegProgress) => void | "pause" | "resume" | "stop") => {
      if (!options) options = {}
      if (options.ffmpegPath) ffmpeg.setFfmpegPath(options.ffmpegPath)
      if (options.ffprobePath) ffmpeg.setFfprobePath(options.ffprobePath)
      if (!dest) dest = "./"
      let episode = null as CrunchyrollEpisode | null
      if (episodeResolvable.hasOwnProperty("url")) {
          episode = episodeResolvable as CrunchyrollEpisode
      } else {
          episode = await Episode.get(episodeResolvable as string, {preferSub: options.preferSub, preferDub: options.preferDub})
      }
      const folder = path.extname(dest) ? path.dirname(dest) : dest
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, {recursive: true})
      if (!path.extname(dest)) dest += `/${episode.collection_name.replace(/-/g, " ")} ${episode.episode_number}.${options.audioOnly ? "mp3" : "mp4"}`
      const stream = episode.stream_data.streams[0]?.url
      if (!stream) return Promise.reject("can't download this episode (is it premium only?)")
      const manifest = await axios.get(stream).then((r) => r.data)
      const m3u8 = Util.parsem3u8(manifest)
      let playlist = m3u8.playlists.find((p: any) => p.attributes.RESOLUTION.height === options?.resolution || 1080)
      if (!playlist) playlist = m3u8.playlists.find((p: any) => p.attributes.RESOLUTION.height === 720)
      if (!playlist) playlist = m3u8.playlists.find((p: any) => p.attributes.RESOLUTION.height === 480)
      if (options.skipConversion) return playlist.uri as string
      let ffmpegArgs = ["-acodec", "copy", "-vcodec", "copy", "-crf", `${options?.quality || 16}`, "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
      if (options.audioOnly) ffmpegArgs = []
      const duration = await new Promise<number>((resolve) => {
        ffmpeg.ffprobe(playlist.uri, function(err: any, metadata: any) {
          resolve(metadata.format.duration)
        })
      })
      await new Promise<void>((resolve) => {
        const video = ffmpeg(playlist.uri).outputOptions(ffmpegArgs).save(dest)
        .on("end", () => resolve())
        .on("error", (err: any) => resolve())
        .on("progress", (progress: FFmpegProgress) => {
          if (!progress.percent) {
            const timemark = progress.timemark.split(".")[0].split(":").map((n) => Number(n)).reduce((acc, time) => (60 * acc) + +time)
            progress.percent = (100 / duration) * timemark
          }
          if (videoProgress) {
            const result = videoProgress(progress)
            if (result === "pause") {
              util.pause(video)
            } else if (result === "resume") {
              util.resume(video)
            } else if (result === "stop") {
              util.abort(video)
            }
          }
        })
      })
      return dest as string
    }

    public static downloadAnime = async (animeResolvable: string | CrunchyrollAnime | CrunchyrollSeason, destFolder?: string, options?: DownloadOptions, totalProgress?: (current: number, total: number) => boolean | void, videoProgress?: (progress: FFmpegProgress) => void | "pause" | "resume" | "stop") => {
      if (!options) options = {}
      const episodes = await Anime.episodes(animeResolvable, {preferSub: options.preferSub, preferDub: options.preferDub})
      const resultArray: string[] = []
      for (let i = 0; i < episodes.length; i++) {
        try {
          const result = await Util.downloadEpisode(episodes[i], destFolder, options, videoProgress)
          resultArray.push(result)
          const stop = totalProgress ? totalProgress(i + 1, episodes.length) : false
          if (stop) break
        } catch {
          continue
        }
      }
      return resultArray
    }

    public static downloadThumbnails = async (episodeResolvable: string | CrunchyrollEpisode, dest?: string, options?: {ffmpegPath?: string}) => {
      if (!options) options = {}
      if (options.ffmpegPath) ffmpeg.setFfmpegPath(options.ffmpegPath)
      if (!dest) dest = "./"
      let episode = null as unknown as CrunchyrollEpisode
      if (episodeResolvable.hasOwnProperty("url")) {
          episode = episodeResolvable as CrunchyrollEpisode
      } else {
          episode = await Episode.get(episodeResolvable as string)
      }
      const folder = `${dest}/${episode.collection_name.replace(/-/g, " ")} ${episode.episode_number}`
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, {recursive: true})
      await new Promise<void>((resolve) => {
          ffmpeg(episode.bif_url).save(`${folder}/thumb%d.png`)
          .on("end", () => resolve())
          .on("error", (err: any) => resolve())
      })
      return folder as string
    }
}
