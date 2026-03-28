"use client"

import { useSettings } from "@/app/settings-provider"
import { emojiForName } from "@/lib/emoji-pool"

interface EmployeeAvatarProps {
  name: string
  size?: number
  className?: string
  onClick?: () => void
}

export function EmployeeAvatar({
  name,
  size = 32,
  className,
  onClick,
}: EmployeeAvatarProps) {
  const { settings } = useSettings()
  const override = name ? settings.employeeOverrides[name] : undefined
  const emoji = override?.emoji || emojiForName(name || '')
  const fontSize = Math.round(size * 0.6)

  return (
    <span
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        borderRadius: "50%",
        flexShrink: 0,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
      }}
    >
      {emoji}
    </span>
  )
}

/** Standalone avatar preview without settings context (for pickers / settings page) */
export function AvatarPreview({
  name,
  size = 32,
  className,
  onClick,
  emoji: overrideEmoji,
}: EmployeeAvatarProps & { emoji?: string }) {
  const emoji = overrideEmoji || emojiForName(name)
  const fontSize = Math.round(size * 0.6)

  return (
    <span
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        borderRadius: "50%",
        flexShrink: 0,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
      }}
    >
      {emoji}
    </span>
  )
}
