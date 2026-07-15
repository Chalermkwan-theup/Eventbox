interface AvailabilityBadgeProps {
  remaining: number;
}

/**
 * Pure presentational badge — no hooks/interactivity of its own, safe to
 * render from either a Server or Client Component tree. Thresholds are a UX
 * judgment call (frontend-dev): "low stock" nudge starts at 5 remaining.
 */
export function AvailabilityBadge({ remaining }: AvailabilityBadgeProps) {
  if (remaining <= 0) {
    return <span className="badge badge--sold-out">หมดแล้ว</span>;
  }

  if (remaining <= 5) {
    return <span className="badge badge--low">เหลือ {remaining} ใบ</span>;
  }

  return <span className="badge badge--ok">เหลือ {remaining} ใบ</span>;
}
