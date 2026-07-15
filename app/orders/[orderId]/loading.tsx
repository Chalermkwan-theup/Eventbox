export default function LoadingOrderResult() {
  return (
    <div className="container container--narrow" aria-hidden="true">
      <div className="card">
        <div className="skeleton skeleton-line skeleton-line--title" />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line skeleton-line--short" />
      </div>
    </div>
  );
}
