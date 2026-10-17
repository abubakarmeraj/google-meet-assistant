// Settings > About has a Reviews section (2026-10-11): a row that opens the
// same review card the app's own prompt opens, at any time, instead of only
// after three sessions or thirty minutes.
//
// The card was built to be one of the launcher's cards. Opened from About it
// sits over Settings, and three things about that are easy to lose:
//
//  1. LAYER. Settings is a GenieModal on the default layer; the card's own
//     layer is far below it, so opened as-is it would appear BEHIND Settings
//     and the button would seem to do nothing.
//  2. ESCAPE. Settings and the launcher each close on a window-level Escape,
//     so one press would close the card and Settings under it.
//  3. THE PROMPT'S WAYS OUT. "Maybe later" and "Never ask" answer a question
//     the app asked. Nobody asked here, and "Never ask" would switch the
//     prompt off for someone who only closed a card they opened themselves.
//
// Source contracts, as the sibling review-modal suites are (the component has
// no render harness in the repo).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');
/** Strip comments so prose describing a behaviour can't satisfy a check. */
const live = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

const ABOUT = live(read('../AboutSection.tsx'));
const MODAL = live(read('../ReviewModal.tsx'));
const HOST = live(read('../ReviewPromptHost.tsx'));
const GENIE = read('../ui/GenieModal.tsx');

describe('About: the Reviews section', () => {
    test('the row opens the review card, and the card is told the user opened it', () => {
        assert.match(ABOUT, /title=\{t\('Reviews'\)\}/, 'the section has its heading');
        assert.match(ABOUT, /onClick=\{\(\) => setReviewOpen\(true\)\}/, 'the button opens the card');
        assert.match(ABOUT, /<ReviewModal[\s\S]*?isOpen=\{reviewOpen\}[\s\S]*?prompted=\{false\}[\s\S]*?\/>/,
            'opened from About the card is not a prompt');
    });

    test('the card is drawn on <body>, outside Settings\' clipped card', () => {
        assert.match(ABOUT, /createPortal\(\s*<ReviewModal[\s\S]*?\/>,\s*document\.body,?\s*\)/,
            'inside the Settings card it would be clipped, and cut into bands with it while the genie runs');
    });

    test('a review from About goes through the prompt\'s two calls', () => {
        assert.match(ABOUT, /electronAPI\?\.reviewSubmit\?\.\(payload\)/);
        assert.match(ABOUT, /electronAPI\?\.reviewUpdateTestimonial\?\.\(\{ review_id: reviewId, \.\.\.payload \}\)/);
    });

    test('one review per install: the button gives way once a review was sent', () => {
        assert.match(ABOUT, /res\.local\?\.has_reviewed \|\| res\.backend\?\.state\?\.has_reviewed/,
            'this device\'s record or the server\'s, whichever knows');
        assert.match(ABOUT, /if \(res\?\.ok\) setHasReviewed\(true\)/, 'and a review sent just now counts at once');
        assert.match(ABOUT, /control=\{hasReviewed \? \([\s\S]*?t\('Sent'\)[\s\S]*?\) : \([\s\S]*?t\('Write a review'\)/,
            'the row shows "Sent" in place of the button');
    });

    test('closing the card from About records no "Maybe later" and no "Never ask"', () => {
        const mount = ABOUT.match(/<ReviewModal[\s\S]*?\/>/)?.[0] ?? '';
        assert.ok(mount, 'the card is mounted');
        assert.doesNotMatch(mount, /onDismissLater|onDismissForever/,
            'those start the prompt\'s seven-day wait, or switch the prompt off for good');
        assert.doesNotMatch(ABOUT, /reviewDismissLater|reviewDismissForever|reviewMarkShown/);
    });
});

describe('Review card: opened by the user', () => {
    test('it is a prompt unless told otherwise, and the prompt host does not say', () => {
        assert.match(MODAL, /prompted = true,/, 'the default is the prompt');
        assert.doesNotMatch(HOST, /prompted=/, 'the prompt host keeps the default');
    });

    test('it sits above Settings', () => {
        const genieLayer = Number(GENIE.match(/zIndex = (\d+),/)?.[1]);
        const promptLayer = Number(MODAL.match(/const PROMPT_LAYER = (\d+)/)?.[1]);
        const overSettings = Number(MODAL.match(/const OVER_SETTINGS_LAYER = (\d+)/)?.[1]);
        assert.ok(Number.isFinite(genieLayer) && Number.isFinite(promptLayer) && Number.isFinite(overSettings), 'all three layers are readable');
        assert.ok(promptLayer < genieLayer, 'the prompt\'s own layer is under Settings, which is why About cannot reuse it');
        assert.ok(overSettings > genieLayer, 'Settings is a GenieModal on the default layer');
        assert.match(MODAL, /zIndex=\{prompted \? PROMPT_LAYER : OVER_SETTINGS_LAYER\}/);
    });

    test('Escape closes this card and not Settings under it', () => {
        assert.match(MODAL, /const overSettings = !prompted/);
        assert.match(MODAL, /if \(overSettings\) \{\s*e\.preventDefault\(\)\s*e\.stopPropagation\(\)\s*\}/,
            'Settings and the launcher both listen for Escape on window');
        assert.match(MODAL, /addEventListener\("keydown", onKey, overSettings\)/, 'capture phase, ahead of theirs');
        assert.match(MODAL, /removeEventListener\("keydown", onKey, overSettings\)/, 'and removed from the same phase');
    });

    test('"Maybe later" and "Never ask" are drawn for the prompt only', () => {
        assert.match(MODAL, /\{prompted && \(\s*<div className="review-quiet-row">[\s\S]*?Maybe later[\s\S]*?Never ask[\s\S]*?<\/div>\s*\)\}/);
    });

    test('each form of the card keeps its own picture for the genie', () => {
        assert.match(MODAL, /snapshotKey=\{prompted \? undefined : "ReviewModal:about"\}/,
            'they differ by a row of buttons; a shared picture would pour out the wrong one');
    });
});

// The owner had "Don't share my words" taken off the second step on
// 2026-10-11. Both buttons left there grant public use, so what keeps the
// fine print ("Never published without permission") true is that every way of
// closing the card on that step makes no call at all.
describe('Review card: the second step has no "Don\'t share my words"', () => {
    const RAW = read('../ReviewModal.tsx');
    const CSS = read('../ReviewModal.css');

    test('the button, its handler and its styles are gone', () => {
        assert.doesNotMatch(MODAL, /share my words/i);
        assert.doesNotMatch(MODAL, /onDecline|handleDeclineTestimonial|review-decline/);
        assert.doesNotMatch(CSS, /\.review-decline/);
    });

    test('the two buttons that are left are the only callers of the publish call', () => {
        const calls = MODAL.match(/updateTestimonial\(/g) || [];
        assert.equal(calls.length, 1, 'one call site, inside submitTestimonial');
        assert.match(MODAL, /const handleSaveTestimonial = \(\) => submitTestimonial\(true\)/);
        assert.match(MODAL, /const handleKeepAnonymous = \(\) => submitTestimonial\(false\)/);
        assert.equal((MODAL.match(/submitTestimonial\(/g) || []).length, 2, 'nothing else reaches it');
    });

    test('closing the card on that step publishes nothing', () => {
        const close = MODAL.match(/const closeModal = \(\) => \{[\s\S]*?\n    \}/)?.[0] ?? '';
        const dismiss = MODAL.match(/const dismissLaterAndClose = useCallback\(\(\) => \{[\s\S]*?\}, \[onDismissLater\]\)/)?.[0] ?? '';
        assert.ok(close && dismiss, 'both ways out are readable');
        assert.doesNotMatch(close + dismiss, /updateTestimonial|submitTestimonial|submitReview/,
            'the close, Escape and a click outside all end here');
        assert.ok(RAW.includes('Never published without permission.'), 'which is what the card still promises');
    });
});

// The owner, 2026-10-12, of the note under the stars: "make this section like
// a message container, people won't understand otherwise". It was a bare
// textarea on the card's ground, so its placeholder read as a caption.
// A first redesign put the stars and the note in one outlined box with a
// hairline and a footer line; he called it "too ugly, like 2000s design". So:
// the stars stay on the ground, and the note is a soft filled surface with no
// compartments and no drawn outline at rest.
describe('Review card: the note is a soft surface', () => {
    const CSS = read('../ReviewModal.css');
    const rule = (sel) => CSS.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';

    test('it is a fill with corners, not an outlined box', () => {
        const box = rule('.review-note');
        assert.match(box, /background: var\(--rv-field\)/);
        assert.match(box, /border-radius: \d+px/);
        assert.doesNotMatch(box, /border: 1px solid/);
    });

    test('the stars are not boxed in with it', () => {
        assert.doesNotMatch(MODAL, /review-composer|review-note-foot/);
        assert.doesNotMatch(CSS, /\.review-composer|\.review-note-foot/);
        assert.doesNotMatch(rule('.review-rating-rail'), /border/);
    });

    test('it answers the pointer and the caret', () => {
        assert.match(rule('.review-note:hover'), /background: var\(--rv-field-live\)/);
        assert.match(rule('.review-note:focus-within'), /background: var\(--rv-field-live\)/);
        assert.match(rule('.review-note-input'), /caret-color: var\(--rv-gold\)/);
    });

    test('both themes define the surface', () => {
        for (const v of ['--rv-field:', '--rv-field-live:', '--rv-field-edge:', '--rv-star-off:']) {
            assert.equal(CSS.split(v).length - 1, 2, `${v} is set for dark and for light`);
        }
    });

    // The owner, 2026-10-12: "the horizontal width of the message box should
    // be as much as the shapes text", the standfirst's first line.
    test('it is as wide as the standfirst\'s first line, whatever the font', () => {
        assert.match(MODAL, /className="review-fit">\s*<p className="review-standfirst">\s*One rating, thirty seconds\. It genuinely shapes<br \/>what we build next\.\s*<\/p>[\s\S]*?className="review-rating-rail"[\s\S]*?className="review-note"/,
            'the line is held where it breaks, and the stars and the note sit in the same box');
        assert.match(rule('.review-fit'), /width: max-content/);
        assert.match(rule('.review-fit .review-standfirst'), /white-space: nowrap/, 'the only child that gives the box a width');
        assert.match(CSS, /\.review-fit \.review-rating-rail,\s*\.review-fit \.review-note \{[^}]*width: 0;[^}]*min-width: 100%;/, 'these ask for none and then fill it');
    });

    test('a click on the surface\'s own padding lands in the textarea', () => {
        assert.match(MODAL, /className="review-note"\s*onClick=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) textareaRef\.current\?\.focus\(\) \}\}/);
    });
});

// The owner, 2026-10-12: "the default rating should be 5 star, people can
// adjust from there", and of the stars, "there's a squircle shadow while
// hovering over stars, remove that".
describe('Review card: it opens on five stars', () => {
    const CSS = read('../ReviewModal.css');

    test('five is the rating it starts with and resets to', () => {
        assert.match(MODAL, /const DEFAULT_RATING = 5\b/);
        assert.match(MODAL, /const \[rating, setRating\] = useState<number>\(DEFAULT_RATING\)/);
        assert.match(MODAL, /if \(isOpen\) \{\s*setStep\("review"\)\s*setRating\(DEFAULT_RATING\)/, 'a second open starts on five again');
        assert.doesNotMatch(MODAL, /setRating\(0\)/);
    });

    test('focus lands on the star that is checked', () => {
        assert.match(MODAL, /querySelector<HTMLButtonElement>\(`\[data-review-star="\$\{DEFAULT_RATING\}"\]`\)/);
        assert.match(MODAL, /onOpened=\{focusChosenStar\}/);
    });

    test('a star under the pointer has no box behind it', () => {
        assert.doesNotMatch(CSS, /\.review-star:hover[^{]*\{[^}]*background/);
        assert.match(MODAL, /onMouseEnter=\{\(\) => !submitting && setHoverRating\(n\)\}/, 'the stars filling up to the pointer is the hover');
    });
});

// The owner, 2026-10-12, of the lock line under the two buttons on the name
// step: "make that single line". At its old size it broke after "on".
describe('Review card: the fine print on the name step is one line', () => {
    const CSS = read('../ReviewModal.css');
    const print = CSS.match(/^\.review-fineprint \{([^}]*)\}/m)?.[1] ?? '';

    test('it does not wrap, and is small enough to fit the column', () => {
        assert.match(print, /white-space: nowrap/);
        assert.match(print, /font-size: 10px/, '11.5px needed 330px of a 292px column');
        assert.match(CSS, /^\.review-fineprint svg \{ flex: none; \}/m, 'the lock keeps its size');
    });

    test('the words are the same', () => {
        assert.ok(read('../ReviewModal.tsx').includes('Never published without permission. Removal on request.'));
    });
});

describe('About: the Reviews section is translated', () => {
    const STRINGS = [
        'Reviews',
        'Tell us how Natively is working for you.',
        'Rate Natively',
        'A star rating and a few words, if you like.',
        'This install has already sent a review. Thank you.',
        'Write a review',
        'Sent',
    ];
    const TABLES = {
        ru: read('../../i18n.tsx'),
        es: read('../../i18n.es.generated.ts'),
        ja: read('../../i18n.ja.generated.ts'),
        zh: read('../../i18n.zh.generated.ts'),
    };
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const text of STRINGS) {
        test(`"${text}" is used by About and has a line in every language`, () => {
            assert.ok(ABOUT.includes(`t('${text}')`), 'About asks for it by this exact text');
            for (const [lang, table] of Object.entries(TABLES)) {
                const line = table.match(new RegExp(`^\\s*['"]${esc(text)}['"]: ['"](.+)['"],$`, 'm'));
                assert.ok(line, `${lang} has no line for it`);
                assert.notEqual(line[1], text, `${lang} only repeats the English`);
            }
        });
    }
});
