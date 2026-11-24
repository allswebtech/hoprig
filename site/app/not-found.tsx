// The 404 page (exported as 404.html, which GitHub Pages serves at every missing address): the content's own text
// (site/content/404.md) in the public frame. It sits at the app's root because only that one is used for an address
// that matches no page; it draws the same frame as the layout group app/(site)/.
import { ContentPage } from './(site)/Content';
import { InstallJump } from './(site)/InstallJump';
import { metaOf, pageAt } from './(site)/site-pages';

export const generateMetadata = async () => metaOf(await pageAt('/404.html'));

export default async function NotFound() {
  return (
    <>
      <a className="skip" href="#main">Skip to the content</a>
      <ContentPage page={await pageAt('/404.html')} />
      <InstallJump />
    </>
  );
}
