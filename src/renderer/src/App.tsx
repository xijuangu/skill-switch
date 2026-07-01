import { useState, useEffect, useCallback } from 'react'

type ScanResult = Awaited<ReturnType<typeof window.api.scan>>
type SkillView = Awaited<ReturnType<typeof window.api.getSkills>>[number]

export default function App() {
  const [skills, setSkills] = useState<SkillView[]>([])
  const [scanning, setScanning] = useState(false)
  const [lastScan, setLastScan] = useState<ScanResult | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.api.getSkills()
    setSkills(result)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleScan = async () => {
    setScanning(true)
    try {
      const result = await window.api.scan()
      setLastScan(result)
      await refresh()
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="min-h-screen flex">
      <nav className="w-48 shrink-0 bg-neutral-100 border-r border-neutral-200 p-4">
        <h1 className="font-bold text-lg mb-6">skill-switch</h1>
        <ul className="space-y-1">
          <li className="px-2 py-1 rounded bg-blue-100 text-blue-800 font-medium">Skills</li>
          <li className="px-2 py-1 text-neutral-400">Tools</li>
          <li className="px-2 py-1 text-neutral-400">Backups</li>
          <li className="px-2 py-1 text-neutral-400">Settings</li>
        </ul>
      </nav>

      <main className="flex-1 p-6 overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Skills</h2>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium"
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>

        {lastScan && (
          <p className="text-sm text-neutral-500 mb-4">
            {lastScan.error
              ? lastScan.error
              : `Scanned ${lastScan.scanned} skill(s), upserted ${lastScan.upserted}.`}
          </p>
        )}

        {skills.length === 0 ? (
          <p className="text-neutral-400">
            No skills indexed yet. Click <span className="font-medium">Scan</span> to discover
            skills in <code className="text-neutral-600">~/.trae-cn/skills</code>.
          </p>
        ) : (
          <ul className="space-y-2">
            {skills.map((skill) => (
              <li
                key={skill.id}
                className="border border-neutral-200 rounded-md p-3 flex items-center justify-between hover:bg-neutral-50"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{skill.name}</span>
                  {skill.sources[0] && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-neutral-200 text-neutral-700">
                      {skill.sources[0].source_type}
                    </span>
                  )}
                </div>
                <span className="text-xs text-neutral-400">
                  {skill.sources.length} source(s)
                </span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
