import json, re, sys, time, urllib.request
key=None
for line in open('/Users/cooper/.dsh/.credentials.yaml',encoding='utf-8'):
    m=re.match(r'\s+DEEPSEEK_API_KEY:\s*(\S+)\s*$',line)
    if m: key=m.group(1)
def ask(messages, system=None, max_tokens=800):
    body={'model':'deepseek-chat','messages':([{'role':'system','content':system}] if system else [])+messages,'temperature':0,'max_tokens':max_tokens}
    req=urllib.request.Request('https://api.deepseek.com/chat/completions',data=json.dumps(body).encode(),headers={'content-type':'application/json','authorization':'Bearer '+key})
    for i in range(4):
        try:
            with urllib.request.urlopen(req,timeout=180) as r: return json.loads(r.read())['choices'][0]['message']['content']
        except Exception: time.sleep(2*(i+1))
    return ''
rows=json.load(open('/tmp/real-work/out/rag-chunks.json',encoding='utf-8'))
system='你是助手。只依据下面提供的资料回答问题。资料里没有的信息就回答「不知道」。问题问到的每件事都要答到；资料里与该问题相关的条件、期限或替代做法也要一并说明。资料里没有说明原因、后续或结果时，要明确说「没有说明」，不要自己推测。只回答问题问到的内容，不要补充与问题无关的细节。如果问题要求你接着讲、续写、发挥或给建议，就基于资料里的设定继续。简短直接，不要复述资料。'
out=[]
for i,r in enumerate(rows):
    prompt=r['rag']+'\n\n用户问题：'+r['question']
    ans=ask([{'role':'user','content':prompt}],system=system)
    out.append({'question':r['question'],'actual':r['actual'],'ragAnswer':ans[:600],'memoryAnswer':''})
    if i%10==0: print(i,flush=True)
json.dump(out, open('/tmp/real-work/out/rag-answers.json','w',encoding='utf-8'), ensure_ascii=False, indent=1)
print('done',len(out))
