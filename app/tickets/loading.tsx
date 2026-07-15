export default function LoadingTickets() {
  return (
    <div className="container" aria-hidden="true">
      <h1>ตั๋วของฉัน</h1>
      <ul className="ticket-list">
        {Array.from({ length: 4 }).map((_, i) => (
          <li key={i} className="ticket-list__item">
            <div className="skeleton skeleton-line skeleton-line--title" />
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line skeleton-line--short" />
          </li>
        ))}
      </ul>
    </div>
  );
}
