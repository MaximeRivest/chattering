// Small safe renderer for this package's own reports. All source text is escaped.
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inline=s=>escape(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
export function renderMarkdown(source){
 const lines=source.split('\n');let out=[],i=0;
 while(i<lines.length){const line=lines[i];
  if(!line.trim()){i++;continue;}
  if(line.startsWith('```')){const code=[];i++;while(i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i++]);i++;out.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');continue;}
  const heading=/^(#{1,6})\s+(.*)/.exec(line);if(heading){const level=Math.min(heading[1].length+1,6);out.push(`<h${level}>${inline(heading[2])}</h${level}>`);i++;continue;}
  if(line.startsWith('|')&&lines[i+1]?.match(/^\|[\s:|\-]+\|$/)){
   const cells=s=>s.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());
   const head=cells(line);out.push('<div class="table-scroll" tabindex="0" role="region" aria-label="Scrollable evidence table"><table><thead><tr>'+head.map(x=>'<th scope="col">'+inline(x)+'</th>').join('')+'</tr></thead><tbody>');i+=2;
   while(i<lines.length&&lines[i].startsWith('|'))out.push('<tr>'+cells(lines[i++]).map(x=>'<td>'+inline(x)+'</td>').join('')+'</tr>');
   out.push('</tbody></table></div>');continue;
  }
  if(/^> /.test(line)){out.push('<blockquote>'+inline(line.slice(2))+'</blockquote>');i++;continue;}
  if(/^\s*[-*] /.test(line)||/^\d+\. /.test(line)){const ordered=/^\d+\. /.test(line),tag=ordered?'ol':'ul';out.push('<'+tag+'>');const re=ordered?/^\d+\. /:/^\s*[-*] /;while(i<lines.length&&re.test(lines[i]))out.push('<li>'+inline(lines[i++].replace(re,''))+'</li>');out.push('</'+tag+'>');continue;}
  const p=[line];i++;while(i<lines.length&&lines[i].trim()&&!/^(#|\||```|>|\s*[-*] |\d+\. )/.test(lines[i]))p.push(lines[i++]);out.push('<p>'+inline(p.join(' '))+'</p>');
 }
 return out.join('\n');
}
