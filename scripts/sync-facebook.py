"""Import a configured RSS/Atom feed at build time. No credentials are published."""
import os, json, re, sys
from pathlib import Path
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import urlparse
from xml.etree import ElementTree as ET
from html.parser import HTMLParser

class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]; self.skip=0
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style'): self.skip+=1
    def handle_endtag(self, tag):
        if tag in ('script','style'): self.skip=max(0,self.skip-1)
    def handle_data(self, data):
        if not self.skip: self.parts.append(data)
def plain(value):
    p=Text(); p.feed(value or ''); return re.sub(r'\s+', ' ', ' '.join(p.parts)).strip()
def safe_url(value):
    p=urlparse(value or '')
    return p.scheme=='https' and bool(p.hostname) and not p.username and not p.password
def parse_feed(raw):
    if len(raw)>2_000_000 or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('Unsupported feed')
    root=ET.fromstring(raw)
    for el in root.iter(): el.tag=el.tag.rsplit('}',1)[-1]
    if root.tag not in ('rss','feed','RDF'): raise ValueError('Not RSS or Atom')
    items=[]; seen=set()
    for el in root.iter():
        if el.tag not in ('item','entry'): continue
        title=plain(el.findtext('title'))[:180]
        link=el.findtext('link','').strip()
        for node in el.findall('link'):
            if node.get('href') and node.get('rel','alternate')=='alternate': link=node.get('href'); break
        if not title or not safe_url(link) or link in seen: continue
        seen.add(link)
        description=plain(el.findtext('description') or el.findtext('summary') or el.findtext('content'))[:360]
        items.append(dict(title=title,description=description,url=link))
        if len(items)==6: break
    return items
def main():
    url=os.environ.get('FACEBOOK_RSS_URL','')
    if not url: print('RSS not configured; retaining the existing snapshot.'); return
    if not safe_url(url): raise ValueError('Configure an HTTPS RSS URL')
    with urlopen(Request(url,headers={'User-Agent':'SintJut-feed-import/1.0'}),timeout=20) as response:
        if not safe_url(response.url): raise ValueError('Unsupported redirect')
        items=parse_feed(response.read(2_000_001))
    data={'mode':'rss','updatedAt':datetime.now(timezone.utc).isoformat(),'items':items}
    target=Path(__file__).resolve().parents[1]/'public/facebook.json'
    temporary=target.with_suffix('.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8'); temporary.replace(target)
    print(f'Imported {len(items)} feed items.')
if __name__=='__main__':
    try: main()
    except Exception:
        print('Feed import failed; existing feed file is retained. Check the source privately.',file=sys.stderr); sys.exit(1)
