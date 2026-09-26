// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Rounds, the simulation and lag compensation of a room.
//
// A round: everybody spawns, four seconds of countdown (PREPARE_TIME 4), then
// the cycles drive until one is left (or none). The last one standing gets
// SCORE_WIN; kills and suicides score as in the original. After a few
// seconds the next round starts; a match ends at the score or round limit.
//
// Lag compensation: a browser moves its own cycle at once and tells the
// server where it turned (the distance it had driven). If the server has
// already simulated past that point, it rewinds the cycle to it, turns, and
// simulates it forward again - as the original does. If the cycle died in
// the meantime, the death waits a moment for such a late turn (about half the
// player's round trip) before it becomes final.

public sealed partial class Room
{
    private enum Phase { Idle, Countdown, Playing, RoundOver }

    private const double Prepare = 4, AfterRound = 5, AfterMatch = 6, MaxRewind = 0.5;

    private const int HistoryLength = 45, MaxPending = 8;

    // CYCLE_SYNC_INTERVAL_SELF .1 and _ENEMY 1 in spirit: everybody hears about
    // their own cycle ten times a second, about all the others three times
    private const int SyncSelfEvery = 6, SyncAllEvery = 18;

    private Phase _phase = Phase.Idle;

    private World _world;

    private SimSettings _sim;

    private int _round, _roundsPlayed, _participants, _tick;

    private double _start, _nextRound, _lastDeath;

    /// <summary>How far the world has been simulated: where a rewound cycle catches up to.</summary>
    private double _simulated;

    private bool _newMatch = true;

    private readonly Random _random = new();

    private double Dt => 1.0 / Lobby.Rate;

    private void Idle()
    {
        _phase = Phase.Idle;
        _world = null;

        foreach (var p in _players)
        {
            p.Cycle = null;
        }

        // the bots go when the last human does
        _players.RemoveAll(p => p.IsBot);

        UpdateInfo();
    }

    private void Game(double now)
    {
        switch (_phase)
        {
            case Phase.Idle:
                if (Humans.Any(p => !p.WantsSpectator))
                {
                    StartRound(now);
                }
                else if (_world == null)
                {
                    // only spectators: show them an empty arena
                    _world = new World(GameMap.Square(Settings.SizeFactor), _sim = Settings.Sim());
                    Send(Snapshot());
                }
                return;

            case Phase.Countdown:
                if (now >= _start - 1e-9)
                {
                    _phase = Phase.Playing;
                    Broadcast(_roundsPlayed >= Settings.RoundLimit || Leader() is { } l && l.Score >= Settings.ScoreLimit
                        ? "Go (extra round; whoever gains the lead wins)!"
                        : $"Go (round {_roundsPlayed + 1} of {Settings.RoundLimit})!");
                }
                break;

            case Phase.RoundOver:
                if (now >= _nextRound)
                {
                    if (Humans.Any(p => !p.WantsSpectator)) StartRound(now);
                    else Idle();
                    return;
                }
                break;
        }

        // (half a step of slack: the ticks and the start are sums of floats)
        if (_phase is Phase.Playing or Phase.RoundOver && now > _start + Dt / 2)
        {
            Simulate(now);
        }

        // (before the start the cycles stand still: nothing to tell)
        if (++_tick % SyncSelfEvery == 0 && _phase is Phase.Playing or Phase.RoundOver && now > _start + Dt / 2)
        {
            SendSync(now, _tick % SyncAllEvery == 0);
        }

        if (_phase == Phase.Playing)
        {
            Analyse(now);
        }
    }

    // -----------------------------------------------------------------------
    // Rounds

    private void StartRound(double now)
    {
        if (_newMatch)
        {
            _newMatch = false;
            _roundsPlayed = 0;

            foreach (var p in _players)
            {
                p.Score = 0;
                p.Kills = 0;
            }

            if (_round > 0)
            {
                Center("New Match", 3);
                Broadcast("Resetting scores...");
            }
        }

        foreach (var p in _players)
        {
            p.Spectator = p.WantsSpectator;
            p.Cycle = null;
            p.History.Clear();
            p.Pending.Clear();
            p.Doom = null;
        }

        UpdateBots();

        _sim = Settings.Sim();
        _world = new World(GameMap.Square(Settings.SizeFactor), _sim);

        _round++;
        _start = now + Prepare;
        _simulated = _start;
        _phase = Phase.Countdown;
        _lastDeath = _start;

        var playing = _players.Where(p => !p.Spectator).OrderBy(_ => _random.Next()).ToList();

        _participants = playing.Count;

        var uses = new int[_world.Map.Spawns.Length];

        foreach (var p in playing)
        {
            Spawn(p, uses);
        }

        foreach (var bot in playing.Where(p => p.IsBot))
        {
            bot.Bot.Spawn(_start, GameMap.SizeMultiplier(_sim.SizeFactor), _sim);
        }

        Send(Snapshot());

        _playersChanged = true;

        UpdateInfo();
    }

    /// <summary>
    /// The least used spawn point; a point used again puts its cycles in a wingman
    /// formation behind the first (SPAWN_WINGMEN_BACK/SIDE).
    /// </summary>
    private void Spawn(Player p, int[] uses)
    {
        var map = _world.Map;

        var index = 0;

        for (var i = 1; i < uses.Length; i++)
        {
            if (uses[i] < uses[index]) index = i;
        }

        var k = uses[index]++;
        var s = map.Spawns[index];

        var (dx, dy) = Axes.Dirs[s.Dir];

        double x = s.X, y = s.Y;

        if (k > 0)
        {
            var side = k % 2 == 1 ? 1 : -1;
            var away = k % 2 == 1 ? (k + 1) / 2 : k / 2;
            var m = Math.Pow(2, Settings.SpeedFactor / 2.0);

            x += (-dx * 2.202896 + side * -dy * 2.75362) * away * m;
            y += (-dy * 2.202896 + side * dx * 2.75362) * away * m;
        }

        var cycle = new Cycle(p.Id, x, y, s.Dir, _start, _sim)
        {
            RubberEff = RubberEffectiveness(p)
        };

        p.Cycle = cycle;
        p.LastTurnN = 0;
        _world.Cycles.Add(cycle);
    }

    /// <summary>
    /// sg_RubberValues: rubber goes further for a higher ping, (rubber + ping *
    /// CYCLE_PING_RUBBER) / rubber. Fixed for the round, so the browser can
    /// simulate its cycle with the same number.
    /// </summary>
    private double RubberEffectiveness(Player p)
    {
        if (p.IsBot || _sim.Rubber <= 0) return 1;

        var ping = Math.Clamp(p.Rtt, 0, 0.5);

        return Math.Round((_sim.Rubber + ping * _sim.PingRubber) / _sim.Rubber, 2);
    }

    /// <summary>Somebody joined during the countdown: they can still take part.</summary>
    private void SpawnLate(Player p)
    {
        if (_phase != Phase.Countdown || _now > _start - 1 || p.Spectator || p.Cycle != null) return;

        var uses = new int[_world.Map.Spawns.Length];

        foreach (var c in _world.Cycles)
        {
            var nearest = 0;
            var best = double.MaxValue;

            for (var i = 0; i < uses.Length; i++)
            {
                var sp = _world.Map.Spawns[i];
                var d = Math.Abs(sp.X - c.Points[0].X) + Math.Abs(sp.Y - c.Points[0].Y);

                if (d < best)
                {
                    best = d;
                    nearest = i;
                }
            }

            uses[nearest]++;
        }

        Spawn(p, uses);

        _participants++;

        Send(Snapshot());
    }

    private void Analyse(double now)
    {
        Player survivor = null;
        int alive = 0, humans = 0;

        foreach (var p in _players)
        {
            // a crash still waiting for a late turn is not decided yet
            if (p.Doom != null) return;

            if (p.Cycle is not { Alive: true }) continue;

            alive++;
            survivor = p;

            if (!p.IsBot) humans++;
        }

        if (_participants >= 2)
        {
            if (alive <= 1 && now - _lastDeath >= 1)
            {
                EndRound(now, survivor, false);
            }
            else if (humans == 0 && now - _lastDeath >= 4)
            {
                // only AIs left: no need to watch them to the end
                EndRound(now, null, true);
            }
        }
        else if (alive == 0 && now - _lastDeath >= 2)
        {
            EndRound(now, null, true);
        }
    }

    private Player Leader() => _players.OrderByDescending(p => p.Score).FirstOrDefault();

    private void EndRound(double now, Player winner, bool quiet)
    {
        _phase = Phase.RoundOver;
        _nextRound = now + AfterRound;
        _roundsPlayed++;

        if (winner != null)
        {
            winner.Score += 10;
            Broadcast($"{winner.Colored} was awarded 10 points for being last active team.");
            Center($"Winner: {winner.Name}", 5);
        }
        else if (!quiet)
        {
            Broadcast("The round ended in a draw.");
            Center("Round Draw!", 5);
        }

        var ranked = _players.OrderByDescending(p => p.Score).ToList();

        if (ranked.Count > 0)
        {
            var leader = ranked[0];
            var ahead = ranked.Count == 1 || leader.Score > ranked[1].Score;

            if (ahead && (leader.Score >= Settings.ScoreLimit || _roundsPlayed >= Settings.RoundLimit))
            {
                var why = leader.Score >= Settings.ScoreLimit ? $"with {leader.Score} points." : $"after {_roundsPlayed} rounds.";

                Broadcast($"Overall Winner: {leader.Colored} {why}");
                Center($"Match Winner: {leader.Name}", AfterMatch);

                _newMatch = true;
                _nextRound = now + AfterRound + AfterMatch;
            }
        }

        _playersChanged = true;

        Send(new PhaseEvent("over", _nextRound));

        UpdateInfo();
    }

    // -----------------------------------------------------------------------
    // Simulation

    private void Simulate(double now)
    {
        var start = now - Dt;

        foreach (var c in _world.Cycles)
        {
            if (c.Alive && !c.Frozen) c.Time = start;
        }

        foreach (var p in _players)
        {
            if (p.IsBot && p.Cycle is { Alive: true } bc)
            {
                p.Bot.Think(this, _world, bc, start);
            }
        }

        var deaths = _world.Step(_world.Cycles, Dt, QueuedTurn);

        _simulated = now;

        foreach (var d in deaths)
        {
            Died(d, now);
        }

        foreach (var p in _players)
        {
            if (p.IsBot || p.Cycle == null) continue;

            var c = p.Cycle;

            if (c.Alive && !c.Frozen)
            {
                Remember(p);
            }

            ProcessPending(p, now);

            if (p.Doom != null && now >= p.Doom.Until)
            {
                var doom = p.Doom;
                p.Doom = null;
                Finalize(p, doom.Time, doom.Owner, false);
            }
        }
    }

    private void Remember(Player p)
    {
        var h = p.History;

        // the oldest state makes room for the newest
        CycleState reuse = null;

        if (h.Count >= HistoryLength)
        {
            reuse = h[0];
            h.RemoveAt(0);
        }

        h.Add(p.Cycle.Save(reuse));
    }

    private Action<Cycle, int> _onQueuedTurn;

    private Action<Cycle, int> QueuedTurn => _onQueuedTurn ??= (c, _) => SendTurn(c);

    private void SendTurn(Cycle c)
    {
        var p = c.Points[^1];

        SendAll(Wire.Turn(c.Id, c.Turns, p.X, p.Y, p.D, p.T, c.Dir, c.V));
    }

    private void Died(Death death, double now)
    {
        var c = death.C;
        var player = _players.FirstOrDefault(p => p.Cycle == c);

        if (player == null)
        {
            c.Alive = false;
            c.DeathTime = c.Time;
            return;
        }

        var killer = c.InfluenceId;

        if (!player.IsBot && player.Client != null)
        {
            // a turn that is still on its way might have avoided this
            var grace = Math.Clamp(player.Rtt * 0.5 + 0.04, 0.03, 0.25);

            c.Frozen = true;
            player.Doom = new Doom(c.Time, killer, now + grace);
            return;
        }

        Finalize(player, c.Time, killer, false);
    }

    private void Finalize(Player player, double time, int killerId, bool silent)
    {
        var c = player.Cycle;

        c.Alive = false;
        c.Frozen = false;
        c.DeathTime = time;

        _world.Explode(c.X, c.Y, _sim.ExplosionRadius);

        _lastDeath = _now;
        _playersChanged = true;

        SendAll(Wire.Die(c.Id, c.X, c.Y, time, silent ? -1 : killerId));

        if (silent || _phase != Phase.Playing) return;

        var killer = killerId >= 0 && killerId != player.Id ? _players.FirstOrDefault(p => p.Id == killerId) : null;

        if (killer != null)
        {
            killer.Score += 3;
            killer.Kills++;
            player.Score -= 2;

            Broadcast($"{killer.Colored} core dumped {player.Colored} for 3 points.");
            Broadcast($"{player.Colored} lost 2 points since it caused a general protection fault.");
        }
        else
        {
            player.Score -= 4;

            Broadcast($"{player.Colored} committed suicide and lost 4 points.");
        }
    }

    // -----------------------------------------------------------------------
    // Input from browsers

    private void OnTurn(Player p, JsonElement m)
    {
        var c = p.Cycle;

        if (c == null || !c.Alive || _phase == Phase.Idle) return;

        var n = m.Int("n");

        // the socket keeps order; anything not newer is a repeat
        if (n <= p.LastTurnN) return;

        p.LastTurnN = n;

        var d = m.Int("d") >= 0 ? 1 : -1;
        var dist = m.Num("dist", c.Dist);

        if (_phase == Phase.Countdown || _now <= _start + Dt / 2)
        {
            // turning on the spot in the last second before the start
            if (_now >= _start - 1 && c.Time >= c.LastTurnTime + _sim.Delay * 0.95)
            {
                _world.Turn(c, d);
                SendTurn(c);
            }
            return;
        }

        if (c.Frozen)
        {
            // dead unless the turn came before the crash
            if (dist < c.Dist - 1e-6) Rewind(p, d, dist);
            return;
        }

        if (dist <= c.Dist + 1e-6)
        {
            if (!Rewind(p, d, dist)) TurnNow(p, d);
        }
        else if (p.Pending.Count < MaxPending)
        {
            p.Pending.Add(new TurnCommand(d, n, dist, _now));
        }
    }

    private void OnBrake(Player p, bool on)
    {
        var c = p.Cycle;

        if (c == null || !c.Alive || c.Frozen || c.Braking == on) return;

        _world.SetBrake(c, on);

        SendAll(Wire.Brake(c.Id, on, c.Time));
    }

    /// <summary>Turns the server had not got to yet: made when the cycle gets there.</summary>
    private void ProcessPending(Player p, double now)
    {
        var c = p.Cycle;

        while (p.Pending.Count > 0 && c.Alive)
        {
            var cmd = p.Pending[0];

            if (c.Frozen)
            {
                // crashed in the very step that went past the turn: it still counts
                p.Pending.RemoveAt(0);

                if (cmd.Dist < c.Dist - 1e-6 && Rewind(p, cmd.D, cmd.Dist)) continue;

                // the browser thought it was further along than the server let it get
                p.Pending.Clear();
                return;
            }

            if (c.Dist >= cmd.Dist)
            {
                p.Pending.RemoveAt(0);

                if (!Rewind(p, cmd.D, cmd.Dist)) TurnNow(p, cmd.D);
            }
            else if (now > cmd.Received + 0.25)
            {
                // the browser was ahead of us; turn where we are
                p.Pending.RemoveAt(0);
                TurnNow(p, cmd.D);
            }
            else
            {
                break;
            }
        }
    }

    private void TurnNow(Player p, int d)
    {
        var c = p.Cycle;

        if (c.Time >= c.LastTurnTime + _sim.Delay * 0.95)
        {
            _world.Turn(c, d);
            SendTurn(c);
            Remember(p);
        }
        else if (c.Queue.Count < MaxPending)
        {
            // too soon after the last one: the queue makes it at the earliest moment
            _world.RequestTurn(c, d);
        }
    }

    /// <summary>
    /// Takes the cycle back to where it had driven dist, turns there, and
    /// simulates it forward to now. Only within its current straight (never
    /// across an earlier turn) and not further back than MaxRewind.
    /// </summary>
    private readonly List<Cycle> _one = [];

    private bool Rewind(Player p, int d, double dist)
    {
        var c = p.Cycle;

        if (dist < c.Points[^1].D + 1e-6) return false;

        CycleState from = null;
        var index = -1;

        for (var i = p.History.Count - 1; i >= 0; i--)
        {
            var h = p.History[i];

            if (h.Turns != c.Turns) break;

            if (h.Dist <= dist + 1e-9)
            {
                from = h;
                index = i;
                break;
            }
        }

        if (from == null || _now - from.Time > MaxRewind) return false;

        var extra = dist - from.Dist;
        var at = from.Time + (extra > 0 ? extra / Math.Max(from.V, 0.1) : 0);

        if (at < c.LastTurnTime + _sim.Delay * 0.95) return false;

        // the brake is as the player has it now: the rewind only moves the turn
        var braking = c.Braking;

        c.Restore(from);
        c.Queue.Clear();

        if (c.Braking != braking) _world.SetBrake(c, braking);
        c.X += c.Dx * extra;
        c.Y += c.Dy * extra;
        c.Dist = dist;
        c.Time = at;
        c.Frozen = false;
        c.Alive = true;

        p.Doom = null;
        p.History.RemoveRange(index + 1, p.History.Count - index - 1);

        _world.Turn(c, d);
        SendTurn(c);

        // and forward again, on the same grid of steps as everybody else, to
        // where they are: turns arrive before this tick's step, which moves it on
        while (c.Alive && !c.Frozen && c.Time < _simulated - 1e-9)
        {
            var next = _start + Math.Floor((c.Time - _start) / Dt + 1 + 1e-6) * Dt;
            var dt = Math.Min(next, _simulated) - c.Time;

            if (dt <= 1e-9) break;

            _one.Clear();
            _one.Add(c);

            var deaths = _world.Step(_one, dt, QueuedTurn);

            foreach (var death in deaths)
            {
                Died(death, _now);
            }

            if (Math.Abs(c.Time - next) < 1e-6 && c.Alive && !c.Frozen)
            {
                Remember(p);
            }
        }

        return true;
    }

    // -----------------------------------------------------------------------
    // What browsers are told

    /// <summary>
    /// The state of the cycles, for the browsers to correct what they
    /// simulated: now and then all of them for everybody, in between each
    /// player's own cycle for that player alone.
    /// </summary>
    private void SendSync(double now, bool all)
    {
        if (all)
        {
            var frame = Wire.Sync(now, _world.Cycles);

            if (frame != null) SendAll(frame);

            return;
        }

        foreach (var p in _players)
        {
            if (p.Client == null || p.Cycle is not { Alive: true } c) continue;

            _one.Clear();
            _one.Add(c);

            p.Client.Send(Wire.Sync(now, _one), FrameType.Binary);
        }
    }

    private Snapshot Snapshot()
    {
        if (_world == null)
        {
            var sim = Settings.Sim();
            return new Snapshot(_round, "idle", 0, _now, sim.ToWire(), GameMap.Square(sim.SizeFactor).Size, []);
        }

        var cycles = _world.Cycles.Select(c =>
        {
            var p = _players.FirstOrDefault(x => x.Cycle == c);

            return new CycleInfo(c.Id, p?.Name ?? "", p?.R ?? 15, p?.G ?? 15, p?.B ?? 15, c.Alive, c.DeathTime,
                                 c.X, c.Y, c.Dir, c.V, c.A, c.LastTs, c.Rubber, c.RubberEff, c.BrakeRes, c.Braking,
                                 c.Dist, c.Turns, c.LastTurnTime, c.Time,
                                 [.. c.Points.Select(pt => new[] { pt.X, pt.Y, pt.D, pt.T })],
                                 [.. c.Holes.Select(h => new[] { h[0], h[1] })]);
        }).ToArray();

        var phase = _phase switch
        {
            Phase.Countdown => "countdown",
            Phase.Playing => "playing",
            Phase.RoundOver => "over",
            _ => "idle"
        };

        return new Snapshot(_round, phase, _start, _now, _sim.ToWire(), _world.Map.Size, cycles);
    }
}
