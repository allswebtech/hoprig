// The story in still form, as plain HTML: one section per step with its heading, its sentence and its three screens
// of the demo (the middle one in front), standing on a faint floor. This is the whole story with no script, with
// reduced motion and with no WebGL; the moving form (StoryMotion) only adds motion over it.
import { Pic, shot } from './Pic';
import { STEPS } from './story-data.mjs';
import { StoryMotion } from './StoryMotion';

export function Story() {
  return (
    <section className="story" aria-labelledby="story-title" data-story>
      <div className="wrap">
        <div className="section-head">
          <p className="t-kicker">How it goes</p>
          <h2 id="story-title" className="t-h2">From one computer to all of them</h2>
        </div>
        <ol className="story-steps">
          {STEPS.map((step, n) => {
            const tall = shot(step.panes[0]).phone;
            const { phoneOrder, phoneSwap } = step as { phoneOrder?: string[]; phoneSwap?: Record<string, string> };
            // Each screen's place on a phone (0 first): the step's phone order, else the one in front first.
            const phoneAt = (name: string, i: number) => (phoneOrder ? phoneOrder.indexOf(name) : [1, 0, 2][i]);
            return (
              <li key={step.id} className="step" id={`story-${step.id}`} data-step={step.id} data-phone-order={(step as { phoneOrder?: string[] }).phoneOrder?.join(',')} data-row-fill={(step as { rowFill?: string[] }).rowFill?.join(',')}>
                {/* One stage: the moving form pins it under the bar, the words as a band over the screens. The still
                    form lays its parts out as before (display: contents). */}
                <div className="step-stage">
                  <div className="step-words">
                    <p className="step-tag">{n + 1} · {step.tag}</p>
                    <h3 className="t-h3">{step.title}</h3>
                    <p className="t-body">{step.text}</p>
                    {/* The step's screens by name, the one in front marked: captions of the moving form, not buttons. */}
                    <ol className="step-screens" aria-hidden="true">
                      {step.panes.map((name) => <li key={name} data-phone-name={phoneSwap?.[name]} data-phone-label={phoneSwap?.[name] && shot(phoneSwap[name]).label}>{shot(name).label}</li>)}
                    </ol>
                  </div>
                  {/* The floor's box: under the words, never beside or over them; the moving form draws into a
                      canvas in it (the still form lays the list out as before). */}
                  <div className="step-floor">
                    <ul className={`floor${tall ? ' floor-tall' : ''}`} role="list" aria-label={`${step.tag}: three screens of the demo`} tabIndex={0}>
                      {step.panes.map((name, i) => (
                        <li key={name} className={`pane pane-${['a', 'b', 'c'][i]}`} data-pane={name} data-phone-at={phoneAt(name, i)}>
                          <figure>
                            <Pic name={name} sizes={tall ? '(max-width: 699px) 70vw, 220px' : i === 1 ? '(max-width: 699px) 86vw, (max-width: 1179px) 92vw, 1124px' : '(max-width: 699px) 86vw, (max-width: 1179px) 46vw, 560px'} />
                            <figcaption className="pane-label">{shot(name).label}</figcaption>
                          </figure>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <StoryMotion />
    </section>
  );
}
