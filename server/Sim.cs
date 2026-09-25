// The light cycle rules on the server: a line-by-line port of web/js/sim.js,
// which has the comments on where each number comes from in the original.
// Change both together - the browser predicts its own cycle with the same
// rules, so a turn happens at the same place on both sides.

public static class Axes
{
    // counter-clockwise: a left turn is +1, a right turn -1
    public static readonly (int X, int Y)[] Dirs = [(1, 0), (0, 1), (-1, 0), (0, -1)];
}

public sealed class SimSettings
{
    public double Speed = 20, SpeedMin = 0.25, StartSpeed = 20, DecayBelow = 5, DecayAbove = 0.1;

    public double Accel = 15, AccelOffset = 2, WallNear = 6, AccelSelf = 1, AccelEnemy = 1, AccelRim = 0;

    public double Brake = 30, BrakeRefill = 0.1, BrakeDeplete = 1;

    public double Delay = 0.1, TurnSpeedFactor = 0.95;

    public int TurnMemory = 3;

    public double Rubber = 1, RubberSpeed = 40, RubberTime = 10, RubberMinDistance = 0.005;

    public double WallsLength = -1, WallsStayUp = 8, ExplosionRadius = 4;

    public int SizeFactor = -3;

    public object ToWire() => new Dictionary<string, object>
    {
        ["speed"] = Speed, ["speedMin"] = SpeedMin, ["startSpeed"] = StartSpeed, ["decayBelow"] = DecayBelow, ["decayAbove"] = DecayAbove,
        ["accel"] = Accel, ["accelOffset"] = AccelOffset, ["wallNear"] = WallNear, ["accelSelf"] = AccelSelf, ["accelEnemy"] = AccelEnemy, ["accelRim"] = AccelRim,
        ["brake"] = Brake, ["brakeRefill"] = BrakeRefill, ["brakeDeplete"] = BrakeDeplete,
        ["delay"] = Delay, ["turnSpeedFactor"] = TurnSpeedFactor, ["turnMemory"] = TurnMemory,
        ["rubber"] = Rubber, ["rubberSpeed"] = RubberSpeed, ["rubberTime"] = RubberTime, ["rubberMinDistance"] = RubberMinDistance,
        ["wallsLength"] = WallsLength, ["wallsStayUp"] = WallsStayUp, ["explosionRadius"] = ExplosionRadius, ["sizeFactor"] = SizeFactor
    };
}

public sealed record Spawn(double X, double Y, int Dir);

public sealed class GameMap
{
    public double Size;

    public Spawn[] Spawns;

    public (double X, double Y)[] Rim;

    public static double SizeMultiplier(int sizeFactor) => Math.Pow(2, sizeFactor / 2.0);

    /// <summary>The original square map: a 500 x 500 rim and twelve spawn points, scaled.</summary>
    public static GameMap Square(int sizeFactor)
    {
        var m = SizeMultiplier(sizeFactor);

        int[][] spawns =
        [
            [255, 50, 1], [245, 450, 3], [50, 245, 0], [450, 255, 2],
            [305, 100, 1], [195, 400, 3], [100, 195, 0], [400, 305, 2],
            [205, 100, 1], [295, 400, 3], [100, 295, 0], [400, 205, 2]
        ];

        var s = 500 * m;

        return new GameMap
        {
            Size = s,
            Spawns = [.. spawns.Select(p => new Spawn(p[0] * m, p[1] * m, p[2]))],
            Rim = [(0, 0), (0, s), (s, s), (s, 0), (0, 0)]
        };
    }
}

public sealed class TrailPoint(double x, double y, double d, double t)
{
    public double X = x, Y = y, D = d, T = t;
}

public sealed class CycleState
{
    public double X, Y, V, A, LastTs, Rubber, BrakeRes, Dist, LastTurnTime, Time;

    public int Dir, Turns;

    public bool Braking;
}

public sealed class Cycle
{
    public Cycle(int id, double x, double y, int dir, double time, SimSettings s)
    {
        Id = id;
        X = x;
        Y = y;
        Dir = dir;
        V = s.StartSpeed;
        LastTurnTime = time - 10;
        Time = time;
        Points.Add(new TrailPoint(x, y, 0, time));
    }

    public int Id;

    public double X, Y, V, A, LastTs, Rubber, BrakeRes = 1, Dist, LastTurnTime, Time, DeathTime;

    public int Dir, Turns;

    public bool Braking, Alive = true, Frozen, RubberActive;

    public readonly List<int> Queue = [];

    public readonly List<TrailPoint> Points = [];

    public readonly List<double[]> Holes = [];

    /// <summary>Whose wall pressed this cycle last, for kill credit.</summary>
    public int InfluenceId = -1;

    public double InfluenceTime = double.NegativeInfinity;

    public int Dx => Axes.Dirs[Dir].X;

    public int Dy => Axes.Dirs[Dir].Y;

    public double Speed() => Math.Max(0, V + 0.5 * LastTs * A);

    public void AccelerationDiscontinuity()
    {
        V = Speed();
        LastTs = 0;
    }

    public CycleState Save() => new()
    {
        X = X, Y = Y, Dir = Dir, V = V, A = A, LastTs = LastTs, Rubber = Rubber, BrakeRes = BrakeRes, Braking = Braking,
        Dist = Dist, Turns = Turns, LastTurnTime = LastTurnTime, Time = Time
    };

    public void Restore(CycleState s)
    {
        X = s.X; Y = s.Y; Dir = s.Dir; V = s.V; A = s.A; LastTs = s.LastTs; Rubber = s.Rubber; BrakeRes = s.BrakeRes;
        Braking = s.Braking; Dist = s.Dist; Turns = s.Turns; LastTurnTime = s.LastTurnTime; Time = s.Time;
    }
}

public sealed class RayHit
{
    public double T, Wx, Wy, Wd, Wt;

    public Cycle Owner;
}

public sealed record Move(Cycle C, double Step, double Dt);

public sealed record Death(Cycle C, Cycle Owner);

public sealed class World
{
    private readonly (double X0, double Y0, double X1, double Y1)[] _rim;

    public World(GameMap map, SimSettings settings)
    {
        Map = map;
        S = settings;

        _rim = new (double, double, double, double)[map.Rim.Length - 1];

        for (var i = 0; i + 1 < map.Rim.Length; i++)
        {
            _rim[i] = (map.Rim[i].X, map.Rim[i].Y, map.Rim[i + 1].X, map.Rim[i + 1].Y);
        }
    }

    public GameMap Map { get; }

    public SimSettings S { get; }

    public readonly List<Cycle> Cycles = [];

    public bool WallDangerous(Cycle c, double d, double t)
    {
        if (!c.Alive && S.WallsStayUp >= 0 && t > c.DeathTime + S.WallsStayUp + 0.2) return false;
        if (S.WallsLength > 0 && d + S.WallsLength < c.Dist) return false;

        foreach (var h in c.Holes)
        {
            if (d >= h[0] && d <= h[1]) return false;
        }

        return true;
    }

    public RayHit Ray(double ox, double oy, double rx, double ry, double maxT, Cycle self, double time)
    {
        RayHit best = null;
        var bestT = maxT;

        foreach (var r in _rim)
        {
            if (Intersect(ox, oy, rx, ry, r.X0, r.Y0, r.X1 - r.X0, r.Y1 - r.Y0, out var t, out _) && t >= 0 && t < bestT)
            {
                bestT = t;
                best = new RayHit { T = t, Owner = null, Wx = r.X1 - r.X0, Wy = r.Y1 - r.Y0, Wd = 0, Wt = -1e9 };
            }
        }

        foreach (var c in Cycles)
        {
            var pts = c.Points;
            var n = pts.Count;

            for (var i = 0; i < n; i++)
            {
                if (c == self && i >= n - 2) continue;

                var p = pts[i];
                double qx, qy, qd, qt;

                if (i + 1 < n)
                {
                    var q = pts[i + 1];
                    qx = q.X; qy = q.Y; qd = q.D; qt = q.T;
                }
                else
                {
                    qx = c.X; qy = c.Y; qd = c.Dist; qt = c.Time;
                }

                var sx = qx - p.X;
                var sy = qy - p.Y;

                if (sx == 0 && sy == 0) continue;

                if (!Intersect(ox, oy, rx, ry, p.X, p.Y, sx, sy, out var t, out var u) || t < 0 || t >= bestT) continue;

                var d = p.D + (qd - p.D) * u;

                if (!WallDangerous(c, d, time)) continue;

                bestT = t;
                best = new RayHit { T = t, Owner = c, Wx = sx, Wy = sy, Wd = d, Wt = p.T + (qt - p.T) * u };
            }
        }

        return best;
    }

    public double WallAcceleration(Cycle c, double time)
    {
        double acc = 0;
        int dx = c.Dx, dy = c.Dy;

        foreach (var side in (ReadOnlySpan<int>)[1, -1])
        {
            double rx = -dx - side * dy, ry = -dy + side * dx;

            var hit = Ray(c.X, c.Y, rx, ry, S.WallNear, c, time);

            if (hit == null) continue;
            if (Math.Abs(hit.Wx * dx + hit.Wy * dy) <= 0.9) continue;

            var h = hit.T;

            double factor;

            if (hit.Owner == null) factor = S.AccelRim;
            else if (hit.Owner == c) factor = S.AccelSelf;
            else factor = S.AccelEnemy;

            if (hit.Owner != null && hit.Owner != c) Influence(c, hit.Owner, hit.Wt - h / Math.Max(c.V, 1));

            acc += factor * S.Accel * (1 / (h + S.AccelOffset) - 1 / (S.WallNear + S.AccelOffset));
        }

        return acc;
    }

    public static void Influence(Cycle c, Cycle owner, double time)
    {
        if (c.InfluenceId < 0 || time > c.InfluenceTime)
        {
            c.InfluenceId = owner.Id;
            c.InfluenceTime = time;
        }
    }

    public bool RequestTurn(Cycle c, int d)
    {
        if (!c.Alive) return false;

        if (c.Queue.Count == 0 && c.Time >= c.LastTurnTime + S.Delay - 1e-6)
        {
            Turn(c, d);
            return true;
        }

        var q = c.Queue;

        if (q.Count <= S.TurnMemory) q.Add(d);
        else if (q[^1] == -d) q.RemoveAt(q.Count - 1);
        else q.Add(d);

        return false;
    }

    public void Turn(Cycle c, int d)
    {
        c.AccelerationDiscontinuity();
        c.V *= S.TurnSpeedFactor;
        c.Dir = (c.Dir + d + 4) % 4;
        c.Turns++;
        c.LastTurnTime = c.Time;
        c.Points.Add(new TrailPoint(c.X, c.Y, c.Dist, c.Time));
    }

    public void SetBrake(Cycle c, bool on)
    {
        if (c.Braking == on) return;

        c.AccelerationDiscontinuity();
        c.Braking = on;
    }

    public double Prepare(Cycle c, double dt, Action<Cycle, int> onTurn)
    {
        if (c.Queue.Count > 0 && c.Time >= c.LastTurnTime + S.Delay - 1e-6)
        {
            var d = c.Queue[0];
            c.Queue.RemoveAt(0);
            Turn(c, d);
            onTurn?.Invoke(c, d);
        }

        var b = S.Speed;
        double a = 0;
        var braking = c.Braking && c.BrakeRes > 0;

        if (braking) a -= S.Brake;

        a += (b - c.V) * (c.V <= b ? S.DecayBelow : S.DecayAbove);
        a += WallAcceleration(c, c.Time);

        var verletDt = 0.5 * (dt + c.LastTs);
        c.LastTs = dt;
        c.V += a * verletDt;
        c.A = a;

        if (c.V < b * S.SpeedMin)
        {
            c.V = b * S.SpeedMin;
            c.A = 0;
        }

        if (braking) c.BrakeRes = Math.Max(0, c.BrakeRes - S.BrakeDeplete * dt);
        else if (c.BrakeRes < 1) c.BrakeRes = Math.Min(1, c.BrakeRes + S.BrakeRefill * dt);

        var step = c.V * dt;
        c.RubberActive = false;

        if (S.Rubber > c.Rubber && S.RubberSpeed > 0)
        {
            var beta = dt * S.RubberSpeed;
            var factor = Math.Min(0.999, beta > 0.001 ? 1 - Math.Exp(-beta) : beta);
            var needed = Math.Max(step / factor, 3 * step);

            var hit = Ray(c.X, c.Y, c.Dx, c.Dy, needed + S.RubberMinDistance, c, c.Time);

            if (hit != null)
            {
                var space = hit.T - S.RubberMinDistance;

                if (hit.Owner != null && hit.Owner != c) Influence(c, hit.Owner, hit.Wt - hit.T / Math.Max(c.V, 1));

                if (space < needed)
                {
                    c.RubberActive = true;

                    var rubberStep = Math.Min(step, Math.Max(0, space) * factor);
                    var use = step - rubberStep;
                    var available = S.Rubber - c.Rubber;

                    if (use <= available)
                    {
                        c.Rubber += use;
                        step = rubberStep;
                    }
                    else
                    {
                        c.Rubber = S.Rubber;
                        step = rubberStep + (use - available);
                    }
                }
            }
        }

        return step;
    }

    public RayHit Collide(Cycle c, double step, List<Move> moves)
    {
        if (step <= 0) return null;

        int dx = c.Dx, dy = c.Dy;

        var hit = Ray(c.X, c.Y, dx, dy, step, c, c.Time);

        var at = hit?.T ?? double.PositiveInfinity;
        var owner = hit?.Owner;
        var wt = hit?.Wt ?? 0;

        foreach (var m in moves)
        {
            if (m.C == c || m.Step <= 0) continue;

            var o = m.C;

            if (!Intersect(c.X, c.Y, dx, dy, o.X, o.Y, o.Dx * m.Step, o.Dy * m.Step, out var t, out var u) || t < 0 || t >= at || u < 0 || u > 1) continue;

            if (u < t / step)
            {
                at = t;
                owner = o;
                wt = o.Time + u * m.Dt;
            }
        }

        return at <= step ? new RayHit { T = at, Owner = owner, Wt = wt } : null;
    }

    /// <returns>null if it survived, otherwise the death</returns>
    public Death Advance(Cycle c, double step, double dt, RayHit hit)
    {
        if (hit != null)
        {
            var back = Math.Max(0, hit.T - S.RubberMinDistance);
            var over = step - back;

            if (over <= S.Rubber - c.Rubber)
            {
                c.Rubber += over;
                step = back;
            }
            else
            {
                var frac = step > 0 ? hit.T / step : 0;
                MoveBy(c, hit.T, dt * frac);

                if (hit.Owner != null && hit.Owner != c) Influence(c, hit.Owner, hit.Wt);

                return new Death(c, hit.Owner);
            }
        }

        MoveBy(c, step, dt);

        if (c.Rubber > S.Rubber) return new Death(c, null);

        c.Rubber /= 1 + dt / S.RubberTime;

        return null;
    }

    private static void MoveBy(Cycle c, double step, double dt)
    {
        c.X += c.Dx * step;
        c.Y += c.Dy * step;
        c.Dist += step;
        c.Time += dt;
    }

    public List<Death> Step(IEnumerable<Cycle> cycles, double dt, Action<Cycle, int> onTurn)
    {
        var moves = new List<Move>();

        foreach (var c in cycles)
        {
            if (!c.Alive || c.Frozen) continue;

            moves.Add(new Move(c, Prepare(c, dt, onTurn), dt));
        }

        var hits = moves.Select(m => Collide(m.C, m.Step, moves)).ToArray();

        var deaths = new List<Death>();

        for (var i = 0; i < moves.Count; i++)
        {
            var r = Advance(moves[i].C, moves[i].Step, dt, hits[i]);

            if (r != null) deaths.Add(r);
        }

        return deaths;
    }

    public void Explode(double x, double y, double radius)
    {
        foreach (var c in Cycles)
        {
            var pts = c.Points;
            var n = pts.Count;

            for (var i = 0; i < n; i++)
            {
                var p = pts[i];
                double qx, qy, qd;

                if (i + 1 < n)
                {
                    qx = pts[i + 1].X; qy = pts[i + 1].Y; qd = pts[i + 1].D;
                }
                else
                {
                    qx = c.X; qy = c.Y; qd = c.Dist;
                }

                var len = qd - p.D;

                if (len <= 0) continue;

                double ux = (qx - p.X) / len, uy = (qy - p.Y) / len;
                var along = (x - p.X) * ux + (y - p.Y) * uy;
                var perp = Math.Abs((x - p.X) * uy - (y - p.Y) * ux);

                if (perp >= radius) continue;

                var half = Math.Sqrt(radius * radius - perp * perp);
                double a = Math.Max(0, along - half), b = Math.Min(len, along + half);

                if (a >= b) continue;

                AddHole(c.Holes, p.D + a, p.D + b);
            }
        }
    }

    private static void AddHole(List<double[]> holes, double a, double b)
    {
        holes.Add([a, b]);
        holes.Sort((u, v) => u[0].CompareTo(v[0]));

        for (var i = 0; i + 1 < holes.Count;)
        {
            if (holes[i + 1][0] <= holes[i][1])
            {
                holes[i][1] = Math.Max(holes[i][1], holes[i + 1][1]);
                holes.RemoveAt(i + 1);
            }
            else
            {
                i++;
            }
        }
    }

    public static bool Intersect(double ox, double oy, double rx, double ry, double px, double py, double sx, double sy, out double t, out double u)
    {
        var den = rx * sy - ry * sx;

        if (Math.Abs(den) < 1e-12)
        {
            t = u = 0;
            return false;
        }

        double qx = px - ox, qy = py - oy;

        t = (qx * sy - qy * sx) / den;
        u = (qx * ry - qy * rx) / den;

        return u >= 0 && u <= 1;
    }
}
