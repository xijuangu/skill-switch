import { describe, it, expect } from 'vitest'
import { groupByHash, shortHash, findSourceGroup } from '../../src/renderer/src/features/skills/sourceGrouping'

describe('sourceGrouping', () => {
  describe('groupByHash', () => {
    it('把同 hash 的来源聚到同一组', () => {
      const sources = [
        { hash: 'aaa', path: '/a' },
        { hash: 'aaa', path: '/b' },
        { hash: 'bbb', path: '/c' },
      ]
      const groups = groupByHash(sources)
      expect(groups.size).toBe(2)
      expect(groups.get('aaa')?.map((s) => s.path)).toEqual(['/a', '/b'])
      expect(groups.get('bbb')?.map((s) => s.path)).toEqual(['/c'])
    })

    it('空列表返回空 Map', () => {
      expect(groupByHash([]).size).toBe(0)
    })

    it('保留插入顺序(同一 hash 的来源按输入顺序排列)', () => {
      const sources = [
        { hash: 'x', path: '/1' },
        { hash: 'y', path: '/2' },
        { hash: 'x', path: '/3' },
      ]
      const groups = groupByHash(sources)
      // Map 迭代顺序 = 插入顺序:第一见到 'x' 在 'y' 之前
      const keys = Array.from(groups.keys())
      expect(keys).toEqual(['x', 'y'])
      expect(groups.get('x')?.map((s) => s.path)).toEqual(['/1', '/3'])
    })
  })

  describe('shortHash', () => {
    it('默认取前 8 位', () => {
      expect(shortHash('abcdef0123456789')).toBe('abcdef01')
    })

    it('可指定长度', () => {
      expect(shortHash('abcdef0123456789', 4)).toBe('abcd')
    })

    it('短于指定长度时返回原值', () => {
      expect(shortHash('abc', 8)).toBe('abc')
    })

    it('空字符串返回空', () => {
      expect(shortHash('')).toBe('')
    })
  })

  describe('findSourceGroup', () => {
    const sources = [
      { hash: 'aaa111', path: '/a' },
      { hash: 'aaa111', path: '/b' },
      { hash: 'bbb222', path: '/c' },
    ]

    it('返回 sourcePath 所属组的 hash 与组内来源数', () => {
      expect(findSourceGroup(sources, '/a')).toEqual({ hash: 'aaa111', count: 2 })
      expect(findSourceGroup(sources, '/b')).toEqual({ hash: 'aaa111', count: 2 })
      expect(findSourceGroup(sources, '/c')).toEqual({ hash: 'bbb222', count: 1 })
    })

    it('sourcePath 不存在时返回 null', () => {
      expect(findSourceGroup(sources, '/missing')).toBeNull()
    })

    it('空列表返回 null', () => {
      expect(findSourceGroup([], '/a')).toBeNull()
    })
  })
})
