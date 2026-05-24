import { AdminConsole } from "../src/admin-console";
import { fetchAdminOverview } from "../src/admin-data";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function AdminPage({ searchParams }: PageProps) {
  const params = searchParams ? await searchParams : {};
  const q = firstParam(params.q);
  const result = await fetchAdminOverview({ q });

  if (!result.ok) {
    return (
      <main className="setup-shell">
        <section className="setup-panel">
          <div className="brand-lockup">
            <span className="brand-mark">IM</span>
            <div>
              <p>InstantML Admin</p>
              <h1>Operator overview unavailable</h1>
            </div>
          </div>
          <p className="setup-copy">{result.message}</p>
          <dl className="setup-list">
            <div>
              <dt>API base</dt>
              <dd>{result.apiBase}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{result.environment}</dd>
            </div>
          </dl>
        </section>
      </main>
    );
  }

  return (
    <AdminConsole
      overview={result.data}
      environment={result.environment}
      apiBase={result.apiBase}
      query={q ?? ""}
    />
  );
}
