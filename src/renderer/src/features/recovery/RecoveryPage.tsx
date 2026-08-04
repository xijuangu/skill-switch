import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Tabs } from '../../shared'
import { SourceArchiveContent } from '../source-archive/SourceArchivePage'
import { BackupsContent } from '../backups/BackupsPage'
import { IgnoredPathsContent } from './IgnoredPathsContent'

type RecoveryTab = 'source-archive' | 'backups' | 'ignored-paths'

// #116:来源归档与备份合并为「恢复」一级入口下的标签,
// 让用户按恢复任务而不是内部存储类型找到入口。
// 「忽略目录」标签管理扫描忽略名单(ignored_source_paths)的查看与解除。
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
          { key: 'backups', label: '备份' },
          { key: 'ignored-paths', label: '忽略目录' }
        ]}
        activeKey={tab}
        onChange={(key) => setTab(key as RecoveryTab)}
      />
      <div className="mt-4">
        {tab === 'source-archive' && <SourceArchiveContent />}
        {tab === 'backups' && <BackupsContent />}
        {tab === 'ignored-paths' && <IgnoredPathsContent />}
      </div>
    </div>
  )
}
