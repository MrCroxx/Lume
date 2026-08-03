import { Cable, ChevronRight, Database, HardDrive, Network } from 'lucide-react'
import type { Storage } from '../types'

export function ConnectionsOverview({
  storages,
  onOpenStorage,
}: {
  storages: Storage[]
  onOpenStorage: (storageId: string, path: string) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-slate-200 bg-white px-5 py-4 sm:px-8">
        <div className="mx-auto max-w-[1500px]">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-slate-400">
            Global view
          </p>
          <h1 className="mt-1 text-lg font-semibold tracking-tight text-slate-950">
            All connections
          </h1>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto overscroll-contain bg-[#f7f8f9] p-5 sm:p-8">
        <section className="mx-auto max-w-[1500px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.025)]">
          <div className="border-b border-slate-100 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-950">Connections</h2>
            <p className="mt-0.5 text-xs text-slate-400">
              {storages.length} connection{storages.length === 1 ? '' : 's'}
            </p>
          </div>

          {storages.length === 0 ? (
            <div className="grid h-64 place-items-center px-6 text-center">
              <div>
                <span className="mx-auto grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-400">
                  <Cable className="size-5" />
                </span>
                <p className="mt-4 text-sm font-medium text-slate-700">
                  No connections are available
                </p>
              </div>
            </div>
          ) : (
            <div className="min-w-[560px]">
              <div className="grid grid-cols-[minmax(320px,1fr)_140px_40px] border-b border-slate-100 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-slate-400">
                <span>Name</span>
                <span>Type</span>
                <span />
              </div>
              {storages.map((storage) => {
                const Icon = storageIcon(storage.kind)
                return (
                  <button
                    key={storage.id}
                    className="group grid w-full grid-cols-[minmax(320px,1fr)_140px_40px] items-center border-b border-slate-100 px-5 py-2.5 text-left last:border-0 hover:bg-slate-50/80"
                    onClick={() => onOpenStorage(storage.id, storage.roots[0] ?? '')}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-950 text-white">
                        <Icon className="size-[18px]" strokeWidth={1.7} />
                      </span>
                      <span className="truncate text-sm font-medium text-slate-700 group-hover:text-slate-950">
                        {storage.name}
                      </span>
                    </span>
                    <span className="font-mono text-xs uppercase text-slate-400">
                      {storage.kind}
                    </span>
                    <ChevronRight className="size-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" />
                  </button>
                )
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function storageIcon(kind: Storage['kind']) {
  if (kind === 'webdav' || kind === 'ftp' || kind === 'sftp') return Network
  if (kind === 's3') return Database
  if (kind === 'fs' || kind === 'smb') return HardDrive
  return Cable
}
