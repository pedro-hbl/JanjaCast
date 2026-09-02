package relay

import (
    "fmt"
    "sort"
    "time"
)

// AwardData is one assigned superlative for the just-finished session.
// Values are preformatted strings (e.g. "47m") suitable for the template.
type AwardData struct {
    Category string
    UserID   string
    Username string
    Value    string
}

// assembleAwardsLocked builds awards from sessionStats. Caller must hold r.mu.
// Returns nil when fewer than 4 distinct participants were seen.
func (r *Room) assembleAwardsLocked() []AwardData {
    if len(r.sessionStats) < 4 {
        return nil
    }
    // Snapshot into a slice for sorting/ties.
    type S = ParticipantStats
    stats := make([]*S, 0, len(r.sessionStats))
    for _, ps := range r.sessionStats { stats = append(stats, ps) }

    // Helper: stable alphabetical by Username, then pick max by key.
    byName := func(a, b *S) int {
        if a.Username == b.Username { return 0 }
        if a.Username < b.Username { return -1 }
        return 1
    }
    // Marathoner: max TotalWatch.
    var marathon *S
    for _, ps := range stats {
        if marathon == nil || ps.TotalWatch > marathon.TotalWatch || (ps.TotalWatch == marathon.TotalWatch && byName(ps, marathon) < 0) {
            marathon = ps
        }
    }
    // Ghost: latest FirstJoin.
    var ghost *S
    for _, ps := range stats {
        if ghost == nil || ps.FirstJoin.After(ghost.FirstJoin) || (ps.FirstJoin.Equal(ghost.FirstJoin) && byName(ps, ghost) < 0) {
            ghost = ps
        }
    }
    // Faithful: Disconnects==0, tie-break by longest watch, then name.
    var faithful *S
    for _, ps := range stats {
        if ps.Disconnects != 0 { continue }
        if faithful == nil || ps.TotalWatch > faithful.TotalWatch || (ps.TotalWatch == faithful.TotalWatch && byName(ps, faithful) < 0) {
            faithful = ps
        }
    }
    // Loudest: max StingerPlays (>0), tiebreak by name.
    var loudest *S
    for _, ps := range stats {
        if ps.StingerPlays <= 0 { continue }
        if loudest == nil || ps.StingerPlays > loudest.StingerPlays || (ps.StingerPlays == loudest.StingerPlays && byName(ps, loudest) < 0) {
            loudest = ps
        }
    }
    // Host: current/last publisher if any.
    var host *S
    if r.publisher != nil {
        host = r.sessionStats[r.publisher.UserID]
    } else {
        // Fallback: pick the person with most watch time as a proxy if present.
        host = marathon
    }

    var out []AwardData
    add := func(cat string, ps *S, val string) {
        if ps == nil { return }
        out = append(out, AwardData{Category: cat, UserID: ps.UserID, Username: ps.Username, Value: val})
    }
    if host != nil { add("host", host, "") }
    if marathon != nil { add("marathon", marathon, durShort(marathon.TotalWatch)) }
    if ghost != nil { add("ghost", ghost, "") }
    if faithful != nil { add("faithful", faithful, durShort(faithful.TotalWatch)) }
    if loudest != nil { add("loudest", loudest, fmt.Sprintf("%d", loudest.StingerPlays)) }

    // Stable order by a fixed category sequence for readability.
    order := map[string]int{"host":0,"marathon":1,"ghost":2,"faithful":3,"loudest":4}
    sort.SliceStable(out, func(i, j int) bool { return order[out[i].Category] < order[out[j].Category] })
    if len(out) == 0 { return nil }
    return out
}

func durShort(d time.Duration) string {
    if d < time.Minute {
        s := int(d.Round(time.Second)/time.Second)
        return fmt.Sprintf("%ds", s)
    }
    m := int(d.Round(time.Minute)/time.Minute)
    return fmt.Sprintf("%dm", m)
}

// RSetAwardsCallback installs the server layer callback.
func RSetAwardsCallback(cb func(roomID string, awards []AwardData)) { rAwardsCallback = cb }
