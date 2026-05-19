import { Plug } from "lucide-react";

import { IntegrationCard } from "./integration-card";
import { PageHead } from "../ui/page-head";
import type { IntegrationRow } from "../../dashboard-types";

type Props = {
  integrationRows: IntegrationRow[];
};

export function IntegrationsTabPane({ integrationRows }: Props) {
  return (
    <>
      <PageHead eyebrow="Admin" title="Integrations" emphasis="and imports" lede="SDK · API · migration paths" />
      <section className="panel">
        <div className="panel-head"><h2><Plug size={15} /> Integrations</h2></div>
        <div className="panel-body integration-grid">
          {integrationRows.map((item) => <IntegrationCard item={item} key={item.name} />)}
        </div>
      </section>
    </>
  );
}
