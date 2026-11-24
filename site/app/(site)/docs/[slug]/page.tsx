// /docs/<slug>/: every page of this kind from the content layer, made at build time (no other address exists).
import { ContentPage } from '../../Content';
import { metaOf, pageAt, slugsUnder } from '../../site-pages';

type Props = { params: Promise<{ slug: string }> };
export const dynamicParams = false;
export const generateStaticParams = () => slugsUnder('docs', 'doc');
export const generateMetadata = async ({ params }: Props) => metaOf(await pageAt(`/docs/${(await params).slug}/`));

export default async function Page({ params }: Props) {
  return <ContentPage page={await pageAt(`/docs/${(await params).slug}/`)} />;
}
