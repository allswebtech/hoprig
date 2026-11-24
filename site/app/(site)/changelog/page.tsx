// /changelog/: its text from the content layer, in the frame.
import { ContentPage } from '../Content';
import { metaOf, pageAt } from '../site-pages';

export const generateMetadata = async () => metaOf(await pageAt('/changelog/'));

export default async function Page() {
  return <ContentPage page={await pageAt('/changelog/')} />;
}
