import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Tabs } from '../../shared'
import { SourceArchiveContent } from '../source-archive/SourceArchivePage'
import { BackupsContent } from '../backups/BackupsPage'

type RecoveryTab = 'source-archive' | 'backups'

// #116:来源归档与备份合并为「恢复」一级入口下的两个标签,
// 让用户按恢复任务而不是内部存储类型找到入口。
export function RecoveryPage() {
  const [tab, setTab] = useState<RecoveryTab>('source-archive')
  return (
    <div className="h-full overflow-auto">
      <div className="flex items-center gap-2 mb-3">
        <RotateCcw className="h-4 w-4 text-foreground-secondary" />
        <h2 className="text-sm font-semibold">恢复</h2>
      </div>
      <Tabs
        tabs={[
          { key: 'source-archive', label: '来源归档' },
          { key: 'backups', label: '备份' }
        ]}
        activeKey={tab}
        onChange={(key) => setTab(key as RecoveryTab)}
      />
      <div className="mt-4">
        {tab === 'source-archive' && <SourceArchiveContent />}
        {tab === 'backups' && <BackupsContent />}
      </div>
    </div>
  )
}
