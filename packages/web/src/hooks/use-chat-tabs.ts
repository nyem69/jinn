"use client"

import { useState, useCallback, useEffect, useMemo } from 'react'

export interface ChatTab {
  sessionId: string
  label: string        // Employee name or session title
  emoji?: string       // Employee avatar emoji (legacy, unused)
  employeeName?: string // Employee name for avatar generation
  status: 'idle' | 'running' | 'error'
  unread: boolean
  /** If true, this is a "pinned" tab (VS Code style) — won't be replaced by preview. */
  pinned?: boolean
}

const STORAGE_KEY = 'jinn-chat-tabs'
const DRAFT_PREFIX = 'jinn-chat-draft-'
const MAX_TABS = 12

interface TabState {
  tabs: ChatTab[]
  activeIndex: number
}

function clampState(state: TabState): TabState {
  if (state.tabs.length === 0) return { tabs: [], activeIndex: -1 }
  if (state.activeIndex < 0 || state.activeIndex >= state.tabs.length) {
    return { tabs: state.tabs, activeIndex: 0 }
  }
  return state
}

function loadTabs(): TabState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return clampState(JSON.parse(raw))
  } catch {}
  return { tabs: [], activeIndex: -1 }
}

function saveTabs(state: TabState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export function useChatTabs() {
  const [{ tabs, activeIndex }, setState] = useState<TabState>({ tabs: [], activeIndex: -1 })

  useEffect(() => {
    setState(loadTabs())
  }, [])

  useEffect(() => {
    saveTabs({ tabs, activeIndex })
  }, [tabs, activeIndex])

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : null

  /**
   * Open a tab in "preview" mode (VS Code style):
   * - If the session is already open, just switch to it.
   * - If there's an existing unpinned preview tab, replace it.
   * - Otherwise, append a new preview tab.
   * The `pinned` field on the incoming tab is respected — if true, it opens pinned.
   */
  const openTab = useCallback((tab: ChatTab) => {
    setState((current) => {
      // Already open? Just switch to it — keep existing label/status
      const existing = current.tabs.findIndex((t) => t.sessionId === tab.sessionId)
      if (existing >= 0) {
        return { ...current, activeIndex: existing }
      }

      // If incoming tab is not explicitly pinned, replace the existing preview tab
      if (!tab.pinned) {
        const previewIdx = current.tabs.findIndex((t) => !t.pinned)
        if (previewIdx >= 0) {
          const nextTabs = [...current.tabs]
          nextTabs[previewIdx] = { ...tab, pinned: false }
          return { tabs: nextTabs, activeIndex: previewIdx }
        }
      }

      if (current.tabs.length >= MAX_TABS) {
        // Replace oldest unpinned tab
        const replaceIdx = current.tabs.findIndex((t) => !t.pinned)
        if (replaceIdx >= 0) {
          const nextTabs = [...current.tabs]
          nextTabs[replaceIdx] = tab
          return { tabs: nextTabs, activeIndex: replaceIdx }
        }
      }

      return {
        tabs: [...current.tabs, tab],
        activeIndex: current.tabs.length,
      }
    })
  }, [])

  /** Pin the tab at the given index (VS Code style — makes it permanent). */
  const pinTab = useCallback((index: number) => {
    setState((current) => {
      if (index < 0 || index >= current.tabs.length) return current
      if (current.tabs[index].pinned) return current
      const nextTabs = current.tabs.map((t, i) => i === index ? { ...t, pinned: true } : t)
      return { ...current, tabs: nextTabs }
    })
  }, [])

  const closeTab = useCallback((index: number) => {
    setState((current) => {
      const sessionId = current.tabs[index]?.sessionId
      if (sessionId) localStorage.removeItem(DRAFT_PREFIX + sessionId)

      const nextTabs = current.tabs.filter((_, i) => i !== index)
      if (nextTabs.length === 0) return { tabs: [], activeIndex: -1 }

      let nextActiveIndex = current.activeIndex
      if (current.activeIndex === index) nextActiveIndex = Math.min(index, nextTabs.length - 1)
      else if (current.activeIndex > index) nextActiveIndex = current.activeIndex - 1

      return { tabs: nextTabs, activeIndex: nextActiveIndex }
    })
  }, [])

  const switchTab = useCallback((index: number) => {
    setState((current) => {
      if (index < 0 || index >= current.tabs.length) return current
      return { ...current, activeIndex: index }
    })
  }, [tabs.length])

  /** Move a tab from one position to another (for drag & drop reordering). */
  const moveTab = useCallback((from: number, to: number) => {
    setState((current) => {
      if (from === to) return current
      if (from < 0 || from >= current.tabs.length) return current
      if (to < 0 || to >= current.tabs.length) return current

      const nextTabs = [...current.tabs]
      const [moved] = nextTabs.splice(from, 1)
      nextTabs.splice(to, 0, moved)

      // Keep activeIndex pointing to the same tab
      let nextActive = current.activeIndex
      if (current.activeIndex === from) {
        nextActive = to
      } else if (from < current.activeIndex && to >= current.activeIndex) {
        nextActive = current.activeIndex - 1
      } else if (from > current.activeIndex && to <= current.activeIndex) {
        nextActive = current.activeIndex + 1
      }

      return { tabs: nextTabs, activeIndex: nextActive }
    })
  }, [])

  const nextTab = useCallback(() => {
    setState((current) => {
      if (current.tabs.length === 0) return current
      return { ...current, activeIndex: (current.activeIndex + 1 + current.tabs.length) % current.tabs.length }
    })
  }, [tabs.length])

  const prevTab = useCallback(() => {
    setState((current) => {
      if (current.tabs.length === 0) return current
      return { ...current, activeIndex: (current.activeIndex - 1 + current.tabs.length) % current.tabs.length }
    })
  }, [tabs.length])

  const clearActiveTab = useCallback(() => {
    setState((current) => ({ ...current, activeIndex: -1 }))
  }, [])

  const saveDraft = useCallback((sessionId: string, text: string) => {
    if (text.trim()) {
      localStorage.setItem(DRAFT_PREFIX + sessionId, text)
    } else {
      localStorage.removeItem(DRAFT_PREFIX + sessionId)
    }
  }, [])

  const loadDraft = useCallback((sessionId: string) => {
    return localStorage.getItem(DRAFT_PREFIX + sessionId) || ''
  }, [])

  const updateTabStatus = useCallback((sessionId: string, updates: Partial<ChatTab>) => {
    setState((current) => {
      const idx = current.tabs.findIndex((t) => t.sessionId === sessionId)
      if (idx < 0) return current
      const tab = current.tabs[idx]
      // Bail out if nothing actually changed — prevents infinite re-render loops
      const keys = Object.keys(updates) as (keyof ChatTab)[]
      if (keys.every((k) => tab[k] === updates[k])) return current
      const nextTabs = current.tabs.map((t, i) => (i === idx ? { ...t, ...updates } : t))
      return { ...current, tabs: nextTabs }
    })
  }, [])

  return useMemo(() => ({
    tabs, activeTab, activeIndex,
    openTab, closeTab, switchTab, nextTab, prevTab,
    pinTab, moveTab,
    clearActiveTab, saveDraft, loadDraft, updateTabStatus,
  }), [tabs, activeTab, activeIndex,
    openTab, closeTab, switchTab, nextTab, prevTab,
    pinTab, moveTab,
    clearActiveTab, saveDraft, loadDraft, updateTabStatus])
}
