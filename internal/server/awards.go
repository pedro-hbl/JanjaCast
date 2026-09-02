package server

import (
    "html/template"
    "net/http"
    "sort"
    "sync"
    "time"
    "github.com/pedro-hbl/janjacast/internal/relay"
)

type awardStore struct {
    mu sync.Mutex
    m  map[string]storedAwards
}
type storedAwards struct {
    at time.Time
    xs []relay.AwardData
}

func (s *Server) initAwards() {
    s.awards = &awardStore{m: make(map[string]storedAwards)}
    // Install relay callback.
    relay.RSetAwardsCallback(func(roomID string, xs []relay.AwardData) {
        // Use roomID as temp id; server endpoint will key by uuid later.
        s.awards.mu.Lock()
        s.awards.m[roomID] = storedAwards{at: time.Now(), xs: append([]relay.AwardData(nil), xs...)}
        s.awards.mu.Unlock()
    })
    // TODO: janitor sweep — simple for now (accept growth in tests)
}

// GET /awards/{id}
func (s *Server) handleAwards(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    s.awards.mu.Lock()
    st, ok := s.awards.m[id]
    s.awards.mu.Unlock()
    if !ok || time.Since(st.at) > 60*time.Minute {
        w.WriteHeader(http.StatusNotFound)
        w.Header().Set("Content-Type", "text/html; charset=utf-8")
        _, _ = w.Write([]byte("<html><body><h1>Trof\xf3us expiraram</h1></body></html>"))
        return
    }
    // stable sort by category for deterministic output
    order := map[string]int{"host":0,"marathon":1,"ghost":2,"faithful":3,"loudest":4}
    xs := append([]relay.AwardData(nil), st.xs...)
    sort.SliceStable(xs, func(i,j int) bool { return order[xs[i].Category] < order[xs[j].Category] })
    // Minimal template for now (full crayon poster is a later step in this issue)
    const tpl = `<!doctype html><meta charset="utf-8"><title>Trophies</title><style>body{font-family: system-ui;margin:24px}</style><h1>Trophies</h1><ul>{{range .}}<li><b>{{.Category}}</b>: {{.Username}} {{.Value}}</li>{{end}}</ul>`
    t := template.Must(template.New("aw").Parse(tpl))
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    _ = t.Execute(w, xs)
}
