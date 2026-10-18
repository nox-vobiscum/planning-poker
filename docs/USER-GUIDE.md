# Planning Poker – Benutzerhandbuch

Dieses Handbuch beschreibt die aktuelle Bedienung von [planning-poker.at](https://planning-poker.at/). Story Points sind relative Größen und keine allgemeingültige Umrechnung in Stunden oder Tage.

## Schnellstart

1. Gib deinen Anzeigenamen und einen Raumcode ein.
2. Teile als Host den Einladungslink über den Link-Button neben dem Raumcode.
3. Konfiguriere bei Bedarf Schätzthema, Kartensatz, Spezialkarten und automatisches Aufdecken.
4. Alle aktiv Mitschätzenden wählen verdeckt eine Karte. Die Auswahl kann bis zum Aufdecken geändert werden.
5. Der Host deckt auf und startet nach der Diskussion eine neue Runde.

Es gibt keine öffentliche Raumliste. Bewahre Link oder Raumcode auf, wenn du zurückkehren möchtest.

## Oberfläche und Einstellungen

Die Raumansicht zeigt Raumdaten, optional das aktuelle Schätzthema, die Teilnehmerliste, Ergebnisse und das Kartenraster. Host-Aktionen erscheinen nur bei entsprechender Berechtigung.

- **Desktop:** Sprache und Darstellung befinden sich im Header.
- **Smartphone:** Sprache und Darstellung befinden sich im Menü.
- **Darstellung:** Hell, Dunkel oder System.
- **Schätzthema:** Der Host kann einen Titel und optionalen Ticket-Link anzeigen, bearbeiten oder entfernen.
- **Automatisches Aufdecken:** Karten werden aufgedeckt, sobald alle aktiven, mitstimmenden Personen eine reguläre Schätzkarte gewählt haben. Zuschauende und Inaktive zählen nicht; Spezialkarten lösen das automatische Aufdecken nicht aus.

## Kartensätze

| Kartensatz | Werte |
|---|---|
| Fibonacci (Scrum Basic) | `1, 2, 3, 5, 8, 13, 20, 40` |
| Fibonacci (Scrum erweitert) | `0, ½, 1, 2, 3, 5, 8, 13, 20, 40, 100, ∞` |
| Fibonacci (mathematisch) | `0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89` |
| Zweierpotenzen | `2, 4, 8, 16, 32, 64, 128` |
| T-Shirt-Größen | `XXS, XS, S, M, L, XL, XXL, XXXL` |

Eine `5` bedeutet in einem numerischen Satz mehr relativen Aufwand oder höhere Komplexität als eine `3`. Welche Vergleichsaufgaben dazu passen, vereinbart das Team selbst.

Die Fragezeichen-Karte steht für eine offene Einschätzung. Zusätzlich kann der Host aktivieren: Kaffee (Pause), Sprechblase (eigenes Gespräch), Teleskop (Spike/Exploration), Warten (Voraussetzung), Link (Abhängigkeit), Warnung (Risiko) und Ziel (Relevanz/Ausrichtung). Spezialkarten sind nicht numerisch und fließen nicht in Durchschnitt, Median oder Spanne ein.

## Teilnehmerstatus

- Eine neutrale Sanduhr bedeutet: Eine aktive Person hat noch keine Karte gewählt.
- Nach verdeckter Stimmabgabe zeigt eine Markierung nur, dass abgestimmt wurde; der Wert bleibt bis zum Aufdecken verborgen.
- Nach dem Aufdecken wird die gewählte Karte angezeigt.
- Ein neutraler Strich kennzeichnet Zuschauende ohne Stimme.
- Inaktive oder getrennte Personen werden gedämpft dargestellt und nehmen nicht aktiv an der Abstimmung teil.

## Ergebnisse

Nur numerische Stimmen von aktiven, mitstimmenden Personen werden berücksichtigt:

- **Durchschnitt:** arithmetischer Mittelwert.
- **Median:** mittlerer Wert der sortierten Stimmen; ab zwei numerischen Stimmen.
- **Spanne:** kleinster bis größter Wert; ab zwei numerischen Stimmen.
- **Konsens:** alle berücksichtigten numerischen Stimmen sind gleich und mindestens eine numerische Stimme liegt vor. Infinity verhindert Konsens; andere Spezialkarten werden nicht numerisch gewertet.

Eine Runde nur mit Spezialkarten hat keine numerische Statistik und keinen Konsens. Eine numerische Stimme zusammen mit Infinity ist ebenfalls kein Konsens.

Nach dem Aufdecken kann ein dezenter Rahmen eine Schätzung kennzeichnen, die am weitesten vom Durchschnitt entfernt liegt. Nur numerische Stimmen zählen. Geprüft wird ab drei numerischen Stimmen. Eine eindeutig am weitesten entfernte Schätzung wird markiert; mehrere gleich weit entfernte Schätzungen erst ab fünf numerischen Stimmen. Gleiche Stimmen erhalten keine Markierung. Sie ist eine Gesprächshilfe, kein Qualitätsurteil.

## Rollen und Berechtigungen

Der Host kann Karten aufdecken, eine neue Runde starten, Raumoptionen und Schätzthema verwalten und den Raum für alle schließen. Im Drei-Punkte-Menü einer anderen berechtigten Person kann der Host die Host-Rolle übertragen, den Zuschauerstatus umschalten oder die Person entfernen. Der Server autorisiert diese Aktionen; Gäste und Zuschauende erhalten keine Host-Aktionen, unzulässige Selbstaktionen werden nicht angeboten.

Aktiv Teilnehmende können abstimmen. Zuschauende verfolgen die Runde ohne Stimme und können im eigenen Menü „Mitschätzen“ aktivieren. Auch der Host kann ihren Status ändern. Der Status bleibt bei Wiederverbindung mit derselben bestehenden Teilnehmeridentität erhalten.

Wenn der Host tatsächlich geht oder nicht zurückkehrt, kann die Rolle gemäß Raum-Lifecycle weitergegeben werden. Eine frühere Host-Person erhält sie bei späterer Rückkehr nicht automatisch zurück.

## Verbindung, Rückkehr und Raumdaten

Die App synchronisiert über WebSocket und versucht nach kurzen Unterbrechungen automatisch, die Verbindung wiederherzustellen. Refresh, Zurück-Navigation oder erneutes Öffnen im selben Browser können dieselbe Teilnahme einschließlich Stimme und Zuschauerstatus wiederherstellen. Dafür speichert der Browser einen raumbezogenen Wiederherstellungsnachweis; der Anzeigename allein genügt nicht.

Wenn dauerhafte Browserspeicherung blockiert ist, zeigt die App einen Hinweis und die Wiederherstellung kann auf den aktuellen Tab oder Seitenaufruf begrenzt sein. Nach „Raum verlassen“, Entfernen durch den Host oder Schließen des Raums ist der alte Nachweis ungültig. Auch ein Server-Deployment kann laufende Räume unterbrechen und einen neuen Beitritt erfordern.

Lebensdauer und Wiederherstellbarkeit eines Raums hängen von der Serverkonfiguration ab. Der Server kann Raum-Snapshots persistent speichern; eine bestimmte Aufbewahrungszeit ist damit nicht garantiert. Planning Poker ersetzt kein dauerhaftes Ticket- oder Ergebnisarchiv.

Auf öffentlichen Seiten kann im selben Browser-Tab ein „Zurück zu Raum“-Link erscheinen, solange eine gültige Rückkehr gespeichert ist. „Raum verlassen“ beendet nur die eigene Teilnahme. „Raum für alle schließen“ beendet als Host-Aktion die Sitzung für alle.

## Tastaturbedienung

Es gibt keine globalen Ziffern-, Reveal- oder Reset-Tastenkürzel.

- Buttons und Karten: Fokus mit `Tab`, Auslösen mit `Enter` oder `Leertaste`.
- Menüs: `Escape` schließt; das Teilnehmeraktionsmenü unterstützt zusätzlich Pfeiltasten, `Pos1` und `Ende`.
- Schätzthema bearbeiten: `Enter` speichert, `Escape` bricht ab.

## Fehlerbehebung

- **Karte nicht auswählbar:** Zuschauerstatus und Verbindung prüfen; nach dem Aufdecken die nächste Runde abwarten.
- **Änderungen fehlen:** Raumcode prüfen, automatische Wiederverbindung abwarten oder neu laden. Proxies/Firewalls können WebSocket blockieren.
- **Name bereits in Verwendung:** Anzeigenamen allein sind keine Identität. Bestehende Einladung und Browsersitzung nutzen oder einen eindeutigen Namen wählen.
- **Teilnahme kann nicht fortgesetzt werden:** Über die Einladung bewusst neu beitreten. Ein alter oder in einem anderen Raum ausgestellter Wiederherstellungsnachweis kann nicht übernommen werden.

## Beispielrunde

Ein Team öffnet einen Raum, trägt eine User Story als Schätzthema ein und wählt Fibonacci (Scrum Basic). Alle aktiv Teilnehmenden wählen verdeckt; eine zuschauende Person verfolgt die Runde ohne Stimme. Nach dem Aufdecken bespricht das Team unterschiedliche Werte und startet eine neue Runde. Ergebnisse werden bei Bedarf im zuständigen Ticketsystem festgehalten.

## Glossar

| Begriff | Bedeutung |
|---|---|
| Story Points | teambezogene relative Größe, keine feste Zeiteinheit |
| Host | Person mit Steuerungs- und Verwaltungsrechten im Raum |
| Zuschauerstatus | Teilnahme ohne eigene Abstimmung |
| Konsens | Übereinstimmung der berücksichtigten numerischen Stimmen nach den oben beschriebenen Regeln |
| Spezialkarte | bewusst gewähltes, nicht numerisches Signal für Gesprächsbedarf |

## Hilfe und Links

- [Anwendung](https://planning-poker.at/)
- [Quellcode und Issues](https://github.com/nox-vobiscum/planning-poker)
- [Dokumentationsübersicht](INDEX.md)

Stand: Oktober 2026
