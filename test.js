fetch('https://open.spotify.com/playlist/2op39WduMGq5C3MnlAyGPb', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
}).then(r => r.text()).then(d => {
    const m = d.match(/<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/);
    console.log(m ? m[1].slice(0, 2000) : 'NOT FOUND');
});