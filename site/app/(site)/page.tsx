// The landing page: the first screen, then the content's bands with the story after the three things, in the frame.
import { landing } from './content';
import { Frame } from './Frame';
import { Hero } from './Hero';
import { Sections } from './Sections';
import { JsonLd, metaOf, pageAt } from './site-pages';
import { Story } from './Story';
import './landing.css';
import './story.css';
import './sections.css';

const words = landing();

export const generateMetadata = async () => metaOf(await pageAt('/'));

export default async function Home() {
  const page = await pageAt('/');
  return (
    <Frame page={page} className="kind-home">
      <Hero page={words} />
      {/* The story follows the three things (SITE.md: the three things, then the screens from the demo). */}
      <Sections body={words.body} after={{ 'what-does-hoprig-do': <Story /> }} />
      <JsonLd page={page} />
    </Frame>
  );
}
