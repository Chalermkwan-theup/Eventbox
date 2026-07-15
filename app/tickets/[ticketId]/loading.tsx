export default function LoadingTicketDetail() {
  return (
    <div className="container container--narrow" aria-hidden="true">
      <div className="card ticket-detail">
        <div className="skeleton skeleton-line skeleton-line--title" />
        <div className="skeleton skeleton-line skeleton-line--short" />
        <div className="skeleton skeleton-qr" />
      </div>
    </div>
  );
}
