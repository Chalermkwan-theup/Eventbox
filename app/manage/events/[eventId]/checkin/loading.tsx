export default function LoadingCheckin() {
  return (
    <div className="container" aria-hidden="true">
      <div className="skeleton skeleton-line skeleton-line--title" />
      <div className="card">
        <div className="skeleton skeleton-qr" />
        <div className="skeleton skeleton-line" />
      </div>
    </div>
  );
}
