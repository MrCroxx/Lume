import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { api } from '../lib/api'
import { formatBytes, formatDate } from '../lib/utils'
import type { FileEntry, FileInfo, MediaStream } from '../types'
import { Button } from './ui/button'
import { Dialog } from './ui/dialog'

export function FileInfoDialog({ storageId, entry, onClose }: {
  storageId: string
  entry: FileEntry
  onClose: () => void
}) {
  const [info, setInfo] = useState<FileInfo | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setInfo(null)
    void api.fileInfo(storageId, entry.path, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setInfo(result) })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : 'Unable to load file information')
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [storageId, entry.path, attempt])

  const file = info ?? entry
  const streams = info?.media?.streams ?? []
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title="File info" description={entry.name} size="wide">
      <div className="space-y-5 pr-1 text-sm">
        <dl className="space-y-2">
          <Detail label="Path" value={file.path || '/'} />
          <Detail label="Type" value={file.kind === 'directory' ? 'Directory' : info?.content_type ?? 'File'} />
          {file.kind !== 'directory' && <Detail label="Size" value={`${formatBytes(file.size)} (${file.size.toLocaleString()} bytes)`} />}
          <Detail label="Modified" value={formatDate(file.modified_at)} />
        </dl>
        {loading && <p role="status" className="flex items-center gap-2 text-slate-500"><LoaderCircle className="size-4 animate-spin" />Loading file information…</p>}
        {(error || info?.media_error) && (
          <div role="alert" className="space-y-2 rounded-lg bg-amber-50 p-3 text-amber-900">
            <p>{error || info?.media_error}</p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
          </div>
        )}
        {info?.media && (
          <>
            <section>
              <h2 className="mb-3 font-semibold text-slate-900">Media</h2>
              <dl className="space-y-2">
                <Detail label="Container" value={info.media.format?.format_name} />
                <Detail label="Duration" value={duration(info.media.format?.duration)} />
                <Detail label="Bit rate" value={bitRate(info.media.format?.bit_rate)} />
              </dl>
            </section>
            {['video', 'audio', 'subtitle'].map((kind) => (
              <section key={kind}>
                <h2 className="mb-3 font-semibold capitalize text-slate-900">{kind} tracks ({streams.filter((stream) => stream.codec_type === kind).length})</h2>
                <div className="grid grid-cols-1 gap-4">
                  {streams.filter((stream) => stream.codec_type === kind).map((stream) => <Track key={stream.index} stream={stream} />)}
                </div>
              </section>
            ))}
            {streams.some((stream) => !['video', 'audio', 'subtitle'].includes(stream.codec_type ?? '')) && (
              <section>
                <h2 className="mb-3 font-semibold text-slate-900">Other tracks</h2>
                <div className="grid grid-cols-1 gap-4">
                  {streams.filter((stream) => !['video', 'audio', 'subtitle'].includes(stream.codec_type ?? '')).map((stream) => <Track key={stream.index} stream={stream} />)}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

function Track({ stream }: { stream: MediaStream }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 break-words font-medium text-slate-800 [overflow-wrap:anywhere]">#{stream.index} · {stream.tags?.title || stream.codec_type || 'Track'}</p>
      <dl className="space-y-2">
        <Detail label="Codec" value={[stream.codec_name, stream.profile].filter(Boolean).join(' · ')} />
        <Detail label="Language" value={stream.tags?.language} />
        <Detail label="Duration" value={duration(stream.duration)} />
        {stream.codec_type === 'video' && <>
          <Detail label="Resolution" value={stream.width && stream.height ? `${stream.width} × ${stream.height}` : undefined} />
          <Detail label="Frame rate" value={frameRate(stream.avg_frame_rate) ?? frameRate(stream.r_frame_rate)} />
          <Detail label="Pixel format" value={stream.pix_fmt} />
        </>}
        {stream.codec_type === 'audio' && <>
          <Detail label="Sample rate" value={stream.sample_rate ? `${stream.sample_rate} Hz` : undefined} />
          <Detail label="Channels" value={[stream.channels, stream.channel_layout].filter(Boolean).join(' · ')} />
        </>}
        {stream.bit_rate && <Detail label="Bit rate" value={bitRate(stream.bit_rate)} />}
        <Detail label="Flags" value={[stream.disposition?.default ? 'Default' : '', stream.disposition?.forced ? 'Forced' : ''].filter(Boolean).join(', ') || 'None'} />
      </dl>
    </div>
  )
}

function Detail({ label, value }: { label: string; value?: string }) {
  return <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-3"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 break-words text-slate-800 [overflow-wrap:anywhere]">{value || 'Unknown'}</dd></div>
}

function duration(value?: string) {
  if (!value || !Number.isFinite(Number(value)) || Number(value) < 0) return undefined
  const milliseconds = Math.round(Number(value) * 1000)
  const seconds = (milliseconds % 60000) / 1000
  const hours = Math.floor(milliseconds / 3600000)
  const minutes = Math.floor(milliseconds / 60000) % 60
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`
}

function frameRate(value?: string) {
  if (!value) return undefined
  const [numerator, denominator = '1'] = value.split('/')
  const rate = Number(numerator) / Number(denominator)
  return Number.isFinite(rate) && rate > 0 ? `${Number(rate.toFixed(3))} fps (${value})` : undefined
}

function bitRate(value?: string) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate > 0 ? `${Math.round(rate / 1000).toLocaleString()} kb/s` : undefined
}
