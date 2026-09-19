import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
});

/**
 * Topics to register with the hub. Google's hub has historically keyed on the
 * `/xml/feeds/` form (it is what YouTube's own docs specify) while the served
 * document self-identifies as `/feeds/`. Subscribing to both costs nothing —
 * duplicate pushes are deduped downstream — and removes the guesswork.
 */
export const topicUrls = (channelId) => [
  `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
  `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
];

/**
 * Parse the YouTube Atom body delivered by WebSub push.
 */
export function parseAtom(xml) {
  const doc = parser.parse(xml);
  const feed = doc?.feed || {};

  const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

  const entries = asArray(feed.entry).map((e) => {
    const links = asArray(e.link);
    const alternate = links.find((l) => l['@_rel'] === 'alternate') || links[0];
    return {
      videoId: e.videoId || String(e.id || '').replace('yt:video:', ''),
      channelId: e.channelId,
      title: typeof e.title === 'object' ? e.title['#text'] : e.title,
      author: e.author?.name,
      published: e.published,
      updated: e.updated,
      link: alternate?.['@_href'],
    };
  }).filter((e) => e.videoId);

  const deleted = asArray(feed['deleted-entry']).map((d) =>
    String(d['@_ref'] || '').replace('yt:video:', ''),
  );

  return { entries, deleted };
}
