export default function LoadingEvents() {
  return (
    <div className="container">
      <h1>กิจกรรมที่เปิดขาย</h1>
      <ul className="event-grid" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="event-card">
            <div className="skeleton skeleton-line skeleton-line--title" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line--short" />
          </li>
        ))}
      </ul>
    </div>
  );
}
