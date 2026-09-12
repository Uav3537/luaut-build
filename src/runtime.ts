/**
 * The methods arrays and strings answer to — `names:filter(f)`, `text:trim()`.
 *
 * Nothing is attached to a table or to the string metatable: the lowerer turns
 * each call into a plain call on the table below, which is emitted once at the
 * top of a file (or of a bundle) and only when something used it. That is what
 * makes these work on any array, including one a Luau library handed over.
 *
 * Indices are Luau's throughout: the first element is 1, `indexOf` and
 * `findIndex` answer `nil` rather than -1, and `slice` takes an inclusive
 * range, counting from the end when given a negative. `sort` takes Luau's
 * comparator. The types in luaut-parser's prelude (`ArrayMethods<T>`,
 * `StringMethods`) say the same thing; the two must be changed together.
 *
 * `__NAME__` is replaced with the local the file gives the table.
 */

/** The array methods, by the name written after `:`. */
export const ARRAY_METHODS = new Set([
    "find", "findIndex", "filter", "map", "forEach", "some", "every", "reduce",
    "includes", "indexOf", "join", "concat", "slice", "flat", "reverse", "sort",
    "push", "pop", "shift", "unshift",
])

/** The string methods that are *not* Luau's own — `upper`, `sub`, `gsub` and
 *  the rest already work on a string, and are left as method calls. */
export const STRING_METHODS = new Set([
    "trim", "trimStart", "trimEnd", "startsWith", "endsWith", "includes",
    "indexOf", "slice", "replace", "replaceAll", "padStart", "padEnd",
])

export const ARRAY_SOURCE = `
local __NAME__ = {}

function __NAME__.find(t, test)
	for i = 1, #t do
		if test(t[i], i) then
			return t[i]
		end
	end
	return nil
end

function __NAME__.findIndex(t, test)
	for i = 1, #t do
		if test(t[i], i) then
			return i
		end
	end
	return nil
end

function __NAME__.filter(t, test)
	local out = {}
	for i = 1, #t do
		if test(t[i], i) then
			out[#out + 1] = t[i]
		end
	end
	return out
end

function __NAME__.map(t, transform)
	local out = {}
	for i = 1, #t do
		out[i] = transform(t[i], i)
	end
	return out
end

function __NAME__.forEach(t, visit)
	for i = 1, #t do
		visit(t[i], i)
	end
end

function __NAME__.some(t, test)
	for i = 1, #t do
		if test(t[i], i) then
			return true
		end
	end
	return false
end

function __NAME__.every(t, test)
	for i = 1, #t do
		if not test(t[i], i) then
			return false
		end
	end
	return true
end

function __NAME__.reduce(t, step, initial)
	local total = initial
	for i = 1, #t do
		total = step(total, t[i], i)
	end
	return total
end

function __NAME__.includes(t, value)
	for i = 1, #t do
		if t[i] == value then
			return true
		end
	end
	return false
end

function __NAME__.indexOf(t, value, start)
	for i = start or 1, #t do
		if t[i] == value then
			return i
		end
	end
	return nil
end

function __NAME__.join(t, separator)
	local out = {}
	for i = 1, #t do
		out[i] = tostring(t[i])
	end
	return table.concat(out, separator or ",")
end

function __NAME__.concat(t, ...)
	local out = {}
	table.move(t, 1, #t, 1, out)
	for i = 1, select("#", ...) do
		local part = select(i, ...)
		table.move(part, 1, #part, #out + 1, out)
	end
	return out
end

-- An inclusive range, as \`string.sub\` takes: \`slice(2, 3)\` is the second and
-- third elements, and a negative counts back from the last.
function __NAME__.slice(t, start, stop)
	local n = #t
	local from = start or 1
	local to = stop or n
	if from < 0 then from = n + from + 1 end
	if to < 0 then to = n + to + 1 end
	if from < 1 then from = 1 end
	if to > n then to = n end
	local out = {}
	for i = from, to do
		out[#out + 1] = t[i]
	end
	return out
end

-- One level, as JavaScript's \`flat()\` does by default.
function __NAME__.flat(t)
	local out = {}
	for i = 1, #t do
		local value = t[i]
		if type(value) == "table" then
			table.move(value, 1, #value, #out + 1, out)
		else
			out[#out + 1] = value
		end
	end
	return out
end

function __NAME__.reverse(t)
	local n = #t
	for i = 1, n // 2 do
		t[i], t[n - i + 1] = t[n - i + 1], t[i]
	end
	return t
end

function __NAME__.sort(t, compare)
	if compare then
		table.sort(t, compare)
	else
		table.sort(t)
	end
	return t
end

function __NAME__.push(t, ...)
	local n = #t
	for i = 1, select("#", ...) do
		t[n + i] = select(i, ...)
	end
	return #t
end

function __NAME__.pop(t)
	local n = #t
	local last = t[n]
	t[n] = nil
	return last
end

function __NAME__.shift(t)
	return table.remove(t, 1)
end

function __NAME__.unshift(t, ...)
	for i = select("#", ...), 1, -1 do
		table.insert(t, 1, (select(i, ...)))
	end
	return #t
end
`

export const STRING_SOURCE = `
local __NAME__ = {}

function __NAME__.trim(s)
	return (string.gsub(string.gsub(s, "^%s+", ""), "%s+$", ""))
end

function __NAME__.trimStart(s)
	return (string.gsub(s, "^%s+", ""))
end

function __NAME__.trimEnd(s)
	return (string.gsub(s, "%s+$", ""))
end

function __NAME__.startsWith(s, text)
	return string.sub(s, 1, #text) == text
end

function __NAME__.endsWith(s, text)
	return #text == 0 or string.sub(s, -#text) == text
end

function __NAME__.includes(s, text)
	return string.find(s, text, 1, true) ~= nil
end

function __NAME__.indexOf(s, text, start)
	local at = string.find(s, text, start or 1, true)
	return at
end

function __NAME__.slice(s, start, stop)
	return string.sub(s, start or 1, stop or -1)
end

-- Plain text, not a pattern: \`replace("a.b", ".", "-")\` changes the dot.
function __NAME__.replace(s, text, replacement)
	if text == "" then
		return replacement .. s
	end
	local at, to = string.find(s, text, 1, true)
	if not at then
		return s
	end
	return string.sub(s, 1, at - 1) .. replacement .. string.sub(s, to + 1)
end

function __NAME__.replaceAll(s, text, replacement)
	if text == "" then
		return s
	end
	local out = {}
	local at = 1
	while true do
		local from, to = string.find(s, text, at, true)
		if not from then
			break
		end
		out[#out + 1] = string.sub(s, at, from - 1)
		out[#out + 1] = replacement
		at = to + 1
	end
	out[#out + 1] = string.sub(s, at)
	return table.concat(out)
end

function __NAME__.padStart(s, length, padding)
	local pad = padding or " "
	if #s >= length or pad == "" then
		return s
	end
	local filler = string.rep(pad, math.ceil((length - #s) / #pad))
	return string.sub(filler, 1, length - #s) .. s
end

function __NAME__.padEnd(s, length, padding)
	local pad = padding or " "
	if #s >= length or pad == "" then
		return s
	end
	local filler = string.rep(pad, math.ceil((length - #s) / #pad))
	return s .. string.sub(filler, 1, length - #s)
end
`
