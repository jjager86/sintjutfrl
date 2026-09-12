# Sint Jut — voorstel

Een mobielvriendelijk digitaal dorpsplein, gebouwd met Astro. De startpagina geeft direct toegang tot activiteiten, dorpsruimtes, verenigingen en veelgestelde vragen. Donkerblauw en frisgroen geven het dorp een herkenbare, rustige uitstraling.

## Wat werkt in dit voorstel
- Dorpsfilter voor voorbeeldactiviteiten, met een lege toestand voor Vierhuis.
- Datum- en dagdeelkeuze voor duidelijk gemarkeerde voorbeeldbeschikbaarheid.
- Informatievenster per ruimte; er worden geen reserveringen verstuurd.
- Uitklapbare verenigingsinformatie en doorzoekbare veelgestelde vragen.
- Slideshow met pauzeknop, toetsenbordbediening via echte knoppen, ondersteuning voor minder beweging en een wekelijks wisselende selectie van maximaal vijf goedgekeurde foto's.

## Voor ingebruikname
De huidige website is via de geopende browser bekeken op 11 september 2026. Zij bevat onder meer Dorpenagenda (zonder gevonden evenementen), beschikbaarheid van Doarpsfinne, Historie, Dorpsfilms, Biodiversiteit, contact en lidmaatschap. Deze verwijzingen zijn verwerkt. Doarpsfinne is een bestaande naam; overige ruimtes en alle beschikbaarheid en activiteiten zijn voorbeelden. Bevestig de echte ruimtes, beheerders, contactgegevens, verenigingen en redactie. Voeg vervolgens een gedeelde gegevensbron toe met redactionele goedkeuring. Reserveringen vereisen een server die overlap controleert en een beheerder die aanvragen bevestigt; presenteer een aanvraag nooit als een definitieve boeking.

## ownCloud
Het voorstel bevat nog geen ownCloud-koppeling of echte historische foto's. Gebruik een alleen-lezen account of een afgeschermde gedeelde map voor de synchronisatie. Een servertaak haalt via WebDAV de goedgekeurde foto's en bijschriften op, maakt kleine webversies en publiceert alleen die bestanden en een manifest. Wachtwoorden blijven op de server; nooit in Astro-clientcode, Git of het openbare manifest.

De slideshow leest `/archive.json`: `{"photos":[{"url":"/archive/foto.jpg","caption":"Plaats en jaartal, met beschrijving","credit":"Fotograaf / collectie","approved":true}]}`. Sorteer de manifestlijst stabiel. De selectie schuift iedere maandag op basis van de datum in Europe/Amsterdam; er is daarvoor geen nieuwe Astro-build nodig wanneer de foto's en het manifest apart worden bijgewerkt. Bij uitsluitend statische hosting vereist een vernieuwd manifest een nieuwe publicatie. Een dagelijkse synchronisatie met een geplande publicatie is daarvoor een eenvoudige eerste inrichting. Bewaar de laatste succesvolle selectie bij synchronisatiefouten.

Voor aansluiting nodig: ownCloud-adres, map, toegestane authenticatiemethode en foto-/publicatierechten. Lever geheimen uitsluitend via een beveiligde configuratie aan. Bepaal wie bijschriften, toestemmingen en wekelijkse thema's beheert.

## Beheer en fasering
1. Bevestig het ontwerp, de namen van ruimtes en de informatie-indeling.
2. Vul echte activiteiten, verenigingsprofielen, initiatieven en contactroutes; geef redacteuren een eenvoudige beheeromgeving.
3. Koppel de ruimteagenda met aanvraag- en bevestigingsproces.
4. Sluit ownCloud aan en controleer foto's, metadata en rechten.
5. Test met inwoners op mobiel, controleer toegankelijkheid en publiceer pas daarna op het eigen domein.

## Ontwikkelen
Installeer met pnpm install en start met pnpm dev. Bouw met pnpm build. De statische uitvoer staat in dist. Dit project gebruikt geen database en slaat geen persoonsgegevens op.

## Uitbreiding: verenigingen, historie, woningbouw en Facebook
- Eigen pagina's: /verenigingen/, /lid-worden/, /dorpsfilms/, /dodenherdenking/ en /woningbouw/.
- Lid worden verwijst naar het gecontroleerde gezamenlijke formulier voor Dorpsbelang, Oranjevereniging en de ijsclub. Er worden geen persoonsgegevens of incassomachtigingen lokaal verzameld.
- Vier gecontroleerde YouTube-video's uit het bestaande dorpsfilmarchief. De speler wordt pas na een klik geladen; bezoekers kunnen ook rechtstreeks naar YouTube.
- Abe Sjipkop en Oranjevereniging Sintjohannesga e.o. hebben eigen vermeldingen. De laatste verwijst naar het door de gebruiker opgegeven ovsintjut.nl. De website daarvan kon niet via webopvraging worden gelezen. De activiteitenomschrijving van Abe Sjipkop is gebaseerd op het RTV Spannenburg-portret van 12 september 2025.
- Woningbouw verwijst naar het gemeentelijke raadsvoorstel van 24 mei 2024. Er worden geen onbevestigde actuele projectstatus, aantallen of inschrijfmogelijkheden gepresenteerd.
- Facebook toont een op 11 september 2026 gecontroleerde momentopname uit de bestaande website. Nog geen automatische koppeling.

### RSS aansluiten
Stel FACEBOOK_RSS_URL in als omgevingsvariabele in een vertrouwde buildomgeving. Voer `python scripts/sync-facebook.py` uit vóór `pnpm build`, controleer de uitvoer en publiceer opnieuw. Een geplande build/publicatie moet apart worden ingericht zodra het feedadres bekend is. Er is geen geplande taak aangemaakt. Feedwachtwoorden of geheime URL's horen niet in Git. Het script publiceert uitsluitend titel, platte beschrijving en HTTPS-berichtlink, maximaal zes items. RSS en Atom worden ondersteund; HTML, onveilige links, DTD's en te grote feeds worden afgewezen of opgeschoond. Bij een importfout blijft het vorige bestand intact en stopt het script met een foutcode. Een lege geldige feed toont een lege toestand. De datum op de pagina is de ophaaldatum, geen verzonnen publicatiedatum. Er is geen externe RSS-proxy gekozen en er zijn geen accounts gekoppeld.
