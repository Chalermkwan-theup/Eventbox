export default function LoadingDashboard() {
  return (
    <div className="container container--wide" aria-hidden="true">
      <div className="skeleton skeleton-line skeleton-line--title" />
      <div className="stat-grid">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card stat-card">
            <div className="skeleton skeleton-line skeleton-line--short" />
            <div className="skeleton skeleton-line skeleton-line--title" />
          </div>
        ))}
      </div>
      <div className="card">
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" />
      </div>
    </div>
  );
}
