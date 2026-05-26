import { PublicReportPage } from "./public-report-page";

type PageProps = {
  params: Promise<{ share_token: string }>;
};

export default async function Page({ params }: PageProps) {
  const { share_token: shareToken } = await params;
  return <PublicReportPage shareToken={shareToken} />;
}
